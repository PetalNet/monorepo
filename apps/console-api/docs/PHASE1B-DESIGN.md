# Phase 1 · N1b — bridges + typed reads: detailed design (board round 1 applied)

_console-backend Fable · 2026-07-13 · board-gated (codex + adversarial sub-agent, both REVISE →
all findings applied here, pre-code). Builds on N1a (merged). Contract:
[contracts/CONSOLE-CONTRACTS.md](contracts/CONSOLE-CONTRACTS.md) §3.3 / §4.3–4.4 / Rules 7,10,11;
entity schemas in `contracts/schemas/entities/`. Review record: DECISIONS-PHASE1.md._

## 1. The read-source decision (lake-projection vs source-of-truth)

Typed reads are "views over the lake + sources of truth" (§3.3). N1b pins which is which:

| Read                                                                                                 | Source                                                            | Notes                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/fleet`, `/heartbeats`, `/registry`, `/workers`, `/governance`, `/cards`, `/box-updates`, `/edge/*` | **lake `current_state` projection** (§2)                          | bridged observational state; "latest per entity"; per-item freshness; renderer-agnostic                        |
| `/tasks`, `/leases`, `/agents`                                                                       | **tracker, read-only, mapped to console scope** (§4)              | single-writer store; never re-projected; console-side visibility→scope mapping + caller-scope filter (Rule 11) |
| `/roster`                                                                                            | **filtered join** (§5) — each source scoped BEFORE association    | per-source `visibility` marker so `null` ≠ access-denied; mixed-source, not an atomic snapshot                 |
| `/executors`                                                                                         | **derived** from lake registry + heartbeat current-state + probes | ActionRow pre-flight liveness                                                                                  |
| `/dashboards`                                                                                        | **Library items_min** (Phase-1 minimal table)                     | dashboards are Library items                                                                                   |

Rationale: bridged, high-churn observational state → lake projection; authoritative single-writer
records (tracker) → read the source but STILL through a console-scope filter so ReBAC stays
consistent across both stores (H2). A server-side join is not an atomic snapshot — the read
declares per-source freshness + visibility so the frontend never reads authz-denied as "no data".

## 2. The `current_state` projection (revised — H1/M1/M2/M3/L1/L2/P2)

**Key = `(kind, subject)`** where `kind` is the **projection-map target bucket**
(`fleet | heartbeat | registry | governance | card | worker | box_update | edge`), NOT the
emission's `subject_kind`. This is load-bearing: `/fleet`, `/heartbeats`, `/registry`,
`/governance` all have `subject_kind = agent, subject = handle`, so keying on `subject_kind`
would collapse four entity kinds onto one row. The bucket disambiguates.

Projection map (emission `type` → `kind`): `fleet.event.*`→fleet · `agent.heartbeat`/`agent.crashed`/`channel.*`→heartbeat ·
`agent.capacity`→registry · `governance.action`/`usage.report`→governance · `card.*`→card ·
`worker.*`/subagents→worker · `box.update_status_changed`→box_update · `doorman.*`→edge.

Table (migration, mirrors `events` RLS mechanics — P2):

```sql
current_state(
  kind text, subject text,
  scope text not null,             -- INVARIANT per (kind,subject) — see below
  state jsonb not null,            -- the entity shape; producer updated_at lives INSIDE here
  observed_at timestamptz not null,-- the lake RECEIPT (received_at), skew-proof (L1)
  producer_ts timestamptz,         -- producer clock, for the >90s offline derivation
  unreachable_since timestamptz,   -- set from bridge.source.unreachable, cleared on next event (L2)
  seq bigint not null,
  primary key (kind, subject))
```

- **Atomic seq-guarded upsert** (M1): `insert … on conflict (kind, subject) do update set … where
excluded.seq > current_state.seq` — one statement, monotonic, race-free under concurrent async
  projector writes; a lower seq never regresses state.
- **Scope invariance** (M2/M3): types backing an AGGREGATE read are stamped the **aggregate's
  scope** (`fleet`) by the bridge, so a `fleet`-granted viewer can read `/fleet` (the flat model
  means `fleet` does NOT imply `agent:janet`, so narrowest-scoping would make aggregate reads
  return empty). `scope` is therefore invariant per `(kind, subject)` by construction; the
  projector ASSERTS it (a scope change for an existing key is rejected + alarmed, never a silent
  visibility flip). Per-user private surfaces (health, etc.) are a different projection + scope,
  out of N1b (Phase 3+).
- **RLS** (P2): `current_state` gets `ENABLE + FORCE ROW LEVEL SECURITY`, the same scoped SELECT
  policy as `events` (console_app/console_ro), and a `console_writer` write-all policy; the
  projector writes as `console_writer`.
- **Freshness** (L1): `observed_at` is the lake `received_at` (immutable, never refreshed on
  read); the producer's own `updated_at` stays inside `state` so the consumer does the
  skew-proof >90s-offline derivation. A dead box goes stale-visible via its immutable
  `observed_at`; `unreachable_since` carries the positive down-evidence into the read (L2).

**Durability** (M1 — the P0): the projector is a **cursored consumer**, not fire-and-forget.
N1a's `appender.append` commits then calls `fanOut` un-awaited, so a crash between commit and
upsert would lose the event. Fix: a durable `projection_checkpoint(name, through_seq)`; on boot
the projector **replays** lake events `where seq > through_seq` in seq order (seq-guard makes
replay idempotent), advances the checkpoint, THEN goes live on fan-out — and typed reads are not
served until the boot replay reaches head. To carry `received_at` to the projector, N1a's
`FanOut` signature widens to `(seq, emission, received_at)` (a small additive change in this PR;
the appender already has `received_at` from the insert).

## 3. The bridge binary (`console-bridge`, Rust) — M5/M6/L3

Per-box Rust binary (own crate `apps/console-bridge`; reuses dispatcher `glitchtip.rs`/`ureq`).
Tails as-built sources, POSTs emissions to `/emit` with a `bridge:<box>` bearer.

- **Local outbox state machine** (M5): `bridge_outbox(id, payload, state pending|accepted,
source_cursor)`. Durably write `(id, payload)` **before** POST; POST; on `202` mark `accepted`
  and only THEN advance the source cursor; retry `pending` forever. "Transactional-with-POST"
  (contract §4.4 wording) is physically impossible across a local store + HTTP — the real
  guarantee is **checkpoint-after-accept + dedup = exactly-once** (crash after 202 → re-POST same
  deterministic id → lake `ON CONFLICT (id)` dedups; crash before 202 → cursor never advanced →
  re-read). A follow-up doc PR corrects the contract's "transactionally" to this precise wording.
- **Deterministic ids**: UUIDv5 over `(source, cursor)` for cursored sources; for
  overwrite-in-place snapshots (`data/fleet/<h>.json`), UUIDv5 over content that **includes the
  producer's monotonic `updated_at`** (M6) — else a same-logical-state rewrite is invisible
  (inherent snapshot lossiness, stated honestly, not claimed as a detectable gap).
- **Batch**: `/emit/batch` checkpoints the **last contiguous accepted** record (per-item ack),
  never the batch high-water — a partial-batch failure must not skip the middle.
- **Gap/unreachable**: `bridge.gap_detected` / `bridge.cursor_reset` when loss is possible;
  `bridge.source.unreachable` when a source goes dark.
- **Sources** (§4.4 table): fleet snapshots (lossy-by-construction, native emit replaces early),
  heartbeat files (state-change + ≥15s keepalive, never 1:1 at 1s), system-outbox (bot-spam
  retirement), tracker events, dispatcher card SQLite (read-only poll). Scope stamped `fleet` for
  fleet-observability types (§2).
- **N1d forward-ref** (L3): the exactly-once guarantee rests on `ON CONFLICT (id)` over today's
  plain `events`; when N1d converts `events` to a hypertable, dedup MUST move to the
  `emission_ids` gate atomically or this guarantee regresses.

## 4. Tracker reads: the visibility→scope mapping (H2)

The tracker's ACL is its OWN model (`owner`, `visibility ∈ shared|private`, `project`), NOT the
lake's scope tags — RLS cannot reach it. console-api reads the tracker over its HTTP RPC with a
broad **service token** (trusted read), then maps each row's tracker visibility to a console
scope and **filters by the caller's resolved scopes** (Rule 11 holds; direct unfiltered SQLite is
rejected):

| Tracker row                         | Console scope stamped | Visible to                          |
| ----------------------------------- | --------------------- | ----------------------------------- |
| has `project_id = P`                | `project:P`           | holders of `project:P` (or `fleet`) |
| `visibility = private`, `owner = U` | `user:U`              | holder of `user:U`                  |
| `visibility = shared`, no project   | `fleet`               | fleet-granted                       |

`/leases` applies the `leasePublic` projection in the read path (strips `claim_token` — the
emit-side scrubber never runs on a direct tracker read). The mapping is a pure function of the
tracker row; a caller sees exactly the tracker rows whose mapped scope is in their grant set.

## 5. `/roster` join + `/executors` (M4)

`/roster` filters EACH source to the caller's scopes BEFORE joining (lake current-state via RLS;
tracker via §4), then associates by handle. Each source contributes a `visibility ∈
visible|absent` marker so a `null` field is unambiguous ("that source has no row" vs "you may not
see it") — the frontend never renders authz-denied as "no data" (Rule 10). The read carries
per-source `observed_at` and is documented as a mixed-source join, not an atomic snapshot.
`/executors` derives liveness from registry (`last_seen_epoch` 90/300s) + heartbeat freshness +
service probes.

## 6. Command-completion tail: executor-SIGNED, bridge relay-only (H3 — the P0)

Rule 6 (completions only from the gating executor's identity) is NOT satisfied by a `bridge:<box>`
bearer allowed to emit completion types — that only moves trust to filesystem write-access on
`result_outbox_dir` (a poisoned outbox and a forging bridge are indistinguishable at the door).
Fix: **the executor signs its result envelope.** Each executor (manager, control-plane,
box-agent) holds an Ed25519 signing keypair (seeded; public key in `executor_keys`). Its result
envelope `{op_id, executor, outcome, result_hash, scope}` is signed with the private key. The
bridge (or the executor directly) delivers the signed envelope to console-api, which:

1. verifies the signature against the executor's registered public key,
2. enforces catalog `executor ↔ signer` identity (the op's gating executor must equal the signer),
3. only then transitions the command ledger (`accepted → applied|failed`) and emits the
   completion under `system:console-api` (trusted) — the authenticity is the verified signature,
   not the bridge.
   A compromised bridge or poisoned outbox cannot forge a completion (no private key). N1b lands the
   signing keys + verification seam; N1c's op router consumes the verified ledger transition.

## 7. Module layout + test plan

```text
apps/console-api/src/
  projector/index.ts   cursored consumer: boot-replay to head, then live fan-out; seq-guarded upsert
  reads/entities.ts    current_state → entity schema (read-envelope, pagination, per-item observed_at)
  reads/tracker.ts     tracker HTTP RPC read + visibility→scope map + caller-scope filter + leasePublic
  reads/roster.ts      per-source-scoped join + visibility markers
  reads/executors.ts   liveness derivation
  completions/verify.ts executor-signature verification → ledger transition
apps/console-bridge/   (new Rust crate) outbox state machine, deterministic ids, cursors, gap/unreachable
```

Tests (disposables, never live Janet): projector — fleet+heartbeat same handle → two rows,
out-of-order/dup → highest-seq wins, crash-replay from checkpoint, fleet-grant reads `/fleet` all
boxes, scope-change rejected; tracker reads — visibility→scope map correctness, caller sees only
mapped-in-scope rows, leasePublic strips claim_token, unfiltered read rejected; roster —
per-source visibility markers, null≠denied; bridge — deterministic id (restart no dup), cursor
after-accept, batch contiguous checkpoint, snapshot same-content invisibility documented,
gap/unreachable emissions; completions — valid signature accepted + ledger transitions, forged/
unsigned/wrong-executor rejected. Fail-closed if `TASKS_DB_PATH` unset/live.

## 7b. Sub-PR split (build-with-consumer, per the knip:prod gate)

N1b lands as two PRs so each ships with its prod consumer (the repo's `knip --strict` gate rejects
unused-in-prod exports — the lab's build-with-consumer discipline):

- **N1b-1 (this PR):** the `current_state` projection (boot-replay + seq-guard + scope invariance)
  and the 8 lake-sourced typed reads (`/fleet`, `/heartbeats`, `/registry`, `/governance`,
  `/cards`, `/box-updates`, `/workers`, `/edge/registry`). Migration for current_state +
  projection_checkpoint (+ forward tables executor_keys, items_min for N1b-2/N1c).
- **N1b-2:** the tracker HTTP reader + `/tasks`, `/leases`, `/agents`, `/roster`, `/executors`
  (uses the §4 visibility→scope mapping + leasePublic in prod); the `console-bridge` Rust crate.
- **Completion-verify (§6)** moves to **N1c** where its consumer (the command ledger) lives — the
  executor-signed + verified path is the same, built alongside the op router that reads it.

## 8. Acceptance

Projection key disambiguates all 8 kinds; projector crash-safe (watermark + replay) + scope-
invariant + RLS-forced; tracker reads ReBAC-consistent + leasePublic; roster null-unambiguous;
bridge exactly-once via outbox state machine + honest snapshot lossiness; completions
executor-signed + forgery-rejected; all on temp DBs/containers.
