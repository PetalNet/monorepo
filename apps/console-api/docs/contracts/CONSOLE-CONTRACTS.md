# Lab Console — Contract Surface (P0, board round 1 applied)

_Branch `feat/console-p0-contracts` · console-backend Fable, 2026-07-12 · REVIEWABLE SPEC ONLY —
no service code in this node. This is the contract the console FRONTEND builds against and the
work list the console-backend phases implement. Machine-readable schemas: [`schemas/`](schemas/)
+ [`schemas/entities/`](schemas/entities/) (JSON Schema draft 2020-12; CI validates examples
with ajv **format assertion ON** — `format` is enforced, not annotation). Board round 1
(5 personas + codex) findings and resolutions: [DECISIONS-P0.md](../DECISIONS-P0.md).
Grounded in: the console specs (`console-fable/specs/src/`, esp. `00-foundations` §6),
WAYFINDER-DECISIONS.md, SYSTEM-MAP-as-built.md, the N0.1 contracts, GRAPHING-BACKEND-BRIEF.md._

The console binds to **four planes**. Where the UI specs and this document disagree, the specs'
*requirements* win and this document has a bug; where this document and an implementation
disagree, this document wins and the implementation has a bug. UI-spec op-name drift is resolved
in `ops.json.spec_name_aliases` (the catalog name is the wire name).

## 0. Rules (inherited from N0.1, extended)

1. **Versioned.** Every instance carries `schema_version` (integer, `const`-pinned). Additive
   optional fields = same version **where `additionalProperties` allows** (the N0.1 qualifier):
   all server→client shapes are `additionalProperties: true` and consumers MUST ignore unknown
   fields; client→server shapes are strict. Rename/remove/retype/enum-meaning change = bump +
   migration note here.
2. **OS-neutral, renderer-agnostic.** No contract requires a POSIX-ism, a DOM, or this frontend.
3. **Timestamps.** RFC 3339 UTC in new contracts; as-built epoch fields keep `*_epoch` names.
   The lake stamps `received_at` on every row; freshness uses it when producer-clock skew
   exceeds threshold (a `clock.skew` emission flags the producer).
4. **Identity.** Handles `^[a-z0-9][a-z0-9._-]*$`; hosts canonical `.N`. Producers normalize.
5. **Tracker ties.** `task_id` rides every contract whose activity belongs to a task.
6. **Secrets.** `claim_token` and bearer tokens never reach a browser, a log line, or the bus.
   The emit path applies a **secret scrubber** (claim_token, `Authorization`, token-shaped
   strings) and rejects on match; bridged card emissions are projected through
   `leasePublic`-equivalent rules before emit. `term.input` envelopes are excluded from access
   logs and self-emissions. Lease projections are `leasePublic` only.
7. **Caller identity is server-stamped.** Nothing trusts a client-asserted principal, scope,
   `sender_class`, capability lane, or **emission source** (§4.3). The API authenticates, then
   stamps. `Principal.kind` binds at the auth path (Authentik header ⇒ human; bearer mint
   record ⇒ agent/system), never inferred from an id string. The principal is carried as a
   verifiable assertion across every executor hop (tracker RPC, manager inlet) — an executor
   never accepts "who this is for" as a plain argument.
8. **Everything emits, everything lands** (/task/710). Every occurrence emits a typed event
   unconditionally AND persists as a queryable statistic. Bus = signals; lake = data.
   Anti-recursion: `console.api.*` self-instrumentation is exempt from self-instrumentation,
   WS *deliveries* are not individually instrumented (per-subscriber counters aggregate), and
   debug-severity self-emissions are sampled.
9. **Named-op symmetry** (/task/683). Every mutation is a named op, identical for humans and
   agents, lane- AND target-authorized, audited. No op → no button.
10. **Freshness is computed, never trusted.** Every read carries freshness metadata; aggregated
    reads carry **per-item** `observed_at` so one dead box cannot hide behind a fresh response.
    Positive evidence is required for "fine"; silence never renders as health.
11. **ReBAC below the tools** (/task/706). Every statistic, signal, and item carries a scope;
    every query runs AS the caller; enforcement is substrate + query layer, never a UI filter.
    The scope model is **flat**: `fleet` does not imply `agent:janet`; visibility is exactly
    the grant set (op authz composes fleet-wide grants via `scope_any` lists).

## 1. The four planes

| Plane   | Contract | Transport | Today's shape it formalizes |
| ------- | -------- | --------- | --------------------------- |
| Query   | `stats.query` as-user + typed entity reads, freshness metadata | HTTPS JSON (`POST /api/v1/query`, `GET /api/v1/<entity>`) | tasks.db rows, heartbeat.json, `data/fleet/*.json`, dispatcher SQLite, capacity SQLite, box_update rows, term_audit |
| Command | Named ops, 1:1 with UI actions, lane+target authorized, two-phase audited | HTTPS JSON (`POST /api/v1/op`) | Matrix `!commands`, spool envelopes, governance actions, token mint/rotate, tracker mutations |
| Bus     | Scoped subscribe over typed signals; authorized unconditional emit | WebSocket (`/api/v1/bus/ws`, frames: `schemas/bus-frame.schema.json`) + HTTPS emit (`POST /api/v1/emit`) | fleet-event stream, backchannel-rpc events, dispatcher card lifecycle, the Matrix bot-spam this retires |
| Library | Rev3 item + link API: hybrid search, typed links, provenance, curation | HTTPS JSON (`/api/v1/library/*`) | tasks / artifacts / feed_items / projects converging into the one store |

One service owns the surface: **`console-api`** (`apps/console-api`) — a gateway + substrate,
not a re-implementation: commands route to their real executors, reads serve from the lake and
the sources of truth. Blast radius, stated plainly: console-api down ⇒ every console surface is
honestly dark and Matrix remains the command floor; the assistant is never a dependency of the
emergency path, and neither is this service pretending otherwise.

### 1.1 Base protocol

- Base URL `https://console-api.petalcat.dev/api/v1` (LAN-only until the doorman enrollment
  gate lands).
- JSON; errors everywhere are `{code (snake_case), message, retryable}` (backchannel-rpc).
- `schema_version` rides every contracted JSON *body* (op envelopes, emissions, WS frames,
  read envelopes). Bare transport acknowledgements (`202 {seq}`, health) are pinned by their
  own schemas instead of carrying versions.
- Idempotency: every mutating request carries client-minted `id` (UUID). Duplicate
  `(principal, id)` within the dedup window (≥24h, ≥ the max retry horizon) returns the
  recorded result; the same id with a different body is rejected (`id_reused`).
- List reads paginate: `limit` (default 200, max 1000), `cursor`, `since`, per-entity filters;
  responses are the `read-envelope` shape (`schemas/entities/read-envelope.schema.json`) with
  `next_cursor`. Responses carry a server byte cap; `truncated: true` when clipped — silent
  truncation is banned.
- `GET /api/v1/health` (`{lake, seq_head, bridges: [{source, last_ingest_at, lag_s}],
  ws_clients, matrix_sync_ok_epoch}`) — systemd watchdog + Traefik gate + the Mindy Line's
  line-health source. `GET /api/v1/me` → the caller's Principal + display/grant name.

### 1.2 Authentication + principal

| Caller | Mechanism |
| ------ | --------- |
| Human (browser) | Authentik SSO via a **dedicated** console-api forwardAuth middleware: per-boot nonce, strip-set == authResponseHeaders, full assist-`auth.py` parity (reject extra/duplicate/underscore-folded/control-char `x-authentik-*` headers, canonicalize names). **Hard precondition:** the shared `:80` entrypoint's `forwardedHeaders.trustedIPs` gap is closed before console-api serves a single authenticated route — this surface carries `host.reboot` and `term.*`, not browser automation. |
| Agent / service | `Authorization: Bearer <token>`. Vault keeps plaintext for re-issue (as-built CP4); console-api's *verification* table stores sha256 only. Revocation is checked **per request**, independent of the grant zookie; rotation grace is bounded and dual-validity audited. |
| System (bridges, internal) | Same bearer path, `system:` subjects, distinct trusted producer registrations (§4.3). |

Every request resolves to a server-stamped **Principal** (`schemas/principal.schema.json`).
`sender_class` derivation: `principal` requires `kind == human && tier ∈ {owner, moderator}`;
an agent token can never reach it. Streaming grants are live: lane/grant revocation tears down
open streams (PTY write included), not just new opens.

## 2. The statistic contract (the L1 canonical shape)

One emission shape serves both doctrines — signal (bus) and statistic (lake) are the same
envelope (`schemas/emission.schema.json`, normative; see its field docs). Highlights:

- **Per-field typing**: `meta.fields.<name> = {unit, kind: gauge|counter|delta|timestamp,
  cardinality}` — the Phase-0 statistic-contract requirement that makes L2 auto-derivation
  honest (aggregation validation consults `kind`; `sum` over a gauge is rejected).
- **Edges baked at ingest**: `subject_kind` types the subject node; optional
  `links: [{rel, to: {kind, id}}]` materializes relationships with the statistic attached, so
  "why?" is a graph walk. `GET /api/v1/graph` (neighbors/walk) is reserved; edge storage is a
  named Phase 1 work item, the walk endpoint Phase 2.
- **Auto-registration, gated**: first emission of a new `type` registers it; per-producer
  new-type rate caps + quarantine (flood/hostile names become curation proposals, not silent
  registry rows). Registry drift = curation proposal.
- **Bounds**: envelope ≤16 KiB, ≤24 dimensions/measures, ≤16 links, batch ≤500 items.
- **Severity** is first-class (`debug|info|warn|danger|p0`), producer-capped (§4.3). The
  dispatcher bridging map (priority 0→p0, 1→danger, 2→warn, 3→info; safety→p0; governance
  red→danger, yellow→warn) affects severity display only — interrupt *eligibility* remains the
  dispatcher's LOCKED `interrupt_policy` domain.
- **Accepted = durable + fanned out**; high-frequency metrics use the same shape and door.

## 3. Query plane

### 3.1 `stats.query` — `POST /api/v1/query`

Runs AS the caller. Modes (`schemas/query-request.schema.json`, mode-discriminated):

1. **Structured** (default): semantic-layer-validated; unknown fields rejected with
   nearest-match hints. Cross-type joins enter via **registered views** — a view is a catalog
   entry like a type (`from: "roster"`); registration is a governed Phase 2 action. The
   all-events view is **`events`** (the Void reads it; the Signals flow line is a 60s-bucket
   `count` over it, unscoped rate served pre-aggregated). Time bucketing carries `fill` +
   `coverage` so uptime distinguishes measured-down from not-measured.
2. **SQL** (lane operator+, never plain viewer): read-only role (the control), pinned
   search_path, `SET`/`SET ROLE`/`RESET` blocked, statement_timeout 20s, keyword list as
   defense-in-depth only. Every view over lake/library/grants is `security_invoker = on`;
   `dblink`/`postgres_fdw`/`file_fdw` absent (Phase 1 acceptance).

Response: `schemas/query-result.schema.json` with `query_ref` (durable id: provenance peek,
PanelSpec indirection, stat-binding target, deterministic re-run — cross-filter re-execution
never needs the LLM). NL→query is `POST /api/v1/ask` (Phase 2, additive).

### 3.2 The statistics catalog — `GET /api/v1/catalog`

The semantic layer, readable, scope-filtered: `schemas/entities/catalog-entry.schema.json`
(type, per-field dimension/measure typing, cardinality, last_emit, emit rate, observed scopes).

### 3.3 Typed entity reads — `GET /api/v1/<entity>`

Every read returns the `read-envelope` (freshness + items + pagination). **Every entity item
shape is pinned in [`schemas/entities/`](schemas/entities/)** — the frontend never reads
another repo to learn a field. Aggregated reads carry per-item `observed_at` (Rule 10).

| Entity (GET) | Schema | Source of truth | Notes |
| ------------ | ------ | --------------- | ----- |
| `/fleet` | `entities/fleet.schema.json` | fleet events (bridged; lake-persisted) | aggregated across boxes; `offline` consumer-derived |
| `/heartbeats` | `entities/heartbeat.schema.json` | manager heartbeat files (bridged) | rows ARE manager heartbeats (one per manager; architects view groups by host); legacy `schema: 1` normalized |
| `/registry` | `entities/registry.schema.json` | control-plane capacity SQLite | liveness derived 90/300s |
| `/agents` | `entities/agent.schema.json` | tracker `agents` table | identity converges to a Library item later; read stays stable |
| `/tasks` | `entities/task.schema.json` | tracker (single writer stays the tasks app) | filters: status, project_id, assignee, since |
| `/leases` | `entities/lease.schema.json` | tracker | `leasePublic` only |
| `/cards` | `entities/card.schema.json` | dispatcher SQLite (read-only poll) | filters: state, recipient |
| `/box-updates` | `entities/box-update.schema.json` | box_update_status collector | `GET /box-updates/{box_id}/raw` → `box-update-raw` (packages[], vulns[]) |
| `/workers` | `entities/worker.schema.json` | subagents.json (bridged) → box-agent inventory (Phase 1) | carries `host` — HouseTile needs no join |
| `/governance` | `entities/governance.schema.json` | control-plane (persisted in Phase 1) | per-agent + pool `$defs` |
| `/attention` | `../attention-item.schema.json` | attention store (§5.3) | `fix_ops` args pre-bound server-side |
| `/subscriptions` | `../subscription.schema.json` | subscription store | incl. digest `window` |
| `/delivery` | `entities/delivery.schema.json` | delivery config | incl. `cocoon_until`, `next_digest_at`; line health also reads `/health.matrix_sync_ok_epoch` |
| `/edge/registry`, `/edge/sessions` | `entities/edge-*.schema.json` | doorman (Phase 1 formalization) | |
| `/dashboards` | `entities/dashboard-item.schema.json` | Library items | incl. `is_home`; content via Library plane |
| `/executors` | `entities/executor.schema.json` | registry + heartbeats + service probes | **pre-flight liveness for every ActionRow** (dispatcher, control-plane, tracker, library, per-box box-agents, managers) |
| `/roster` | `entities/roster.schema.json` | server-side join | the Agents surface in ONE read (fleet × heartbeat × registry × agents × governance × leases × workers) |
| `/me` | `entities/me.schema.json` | auth | Principal + display/grant name (session chip) |

History reads (comms log, audit trails, the Void, delivery log, restart counts) are
`stats.query` reads over persisted emissions. `audit.op` emissions pin `subject` = the target
entity, so per-target derivations (restart counts per handle) are one `group_by`.

## 4. Bus plane

### 4.1 Subscribe — `WS /api/v1/bus/ws` (frames: `schemas/bus-frame.schema.json`, normative)

Protocol summary (details in the schema): one **serialized appender** assigns `seq` in
durable-commit order and fans out only after commit — no assignment/commit race. Subscribe
(optionally with exclusive `since`) → **ack** with `replay_through_seq` → replay ≤ boundary →
live > boundary; exact cutover, no duplicates within a subscription. Filtered streams have
global-seq gaps by design (not loss). Slow consumers get a bounded queue; overflow emits a
**gap frame** (heal via `since`) or a coded close — never silent drop. `since` below retention
→ **resync_required** (re-read state from the query plane). Grant changes re-fence live
sockets: affected subscriptions are torn down, not honored from a stale snapshot. The 15s
heartbeat frame carries `seq_head` + per-source ingest lag — "everything is fine" requires the
heartbeat fresh AND ingest flowing, not just a live socket.

### 4.2 Standing subscriptions + escalation

`schemas/subscription.schema.json`: `{pattern, filter?, tier, loud, window, note, owner}`.
Digests are **server-assembled** per owner+window (a digest emission per batch;
`digest.failed` on assembly failure; `next_digest_at` echoed in `/delivery`). Interrupt tier
is validated (`interrupt_ineligible` otherwise) and reserved per /task/709. Delivery is Matrix
by default; every delivery lands a `delivery.receipt` emission **scoped `user:<owner>`**
(target addresses are PII). Storm damping: sustained ≥60 events/5min per (owner × pattern)
auto-mutes to digest via `signal.snooze` attributed to `system:bus` — agent-editable threshold.

### 4.3 Emit — `POST /api/v1/emit` (+ `/emit/batch`, ≤500)

**Emit authorization matrix** (Rule 7 applied to producers):

1. **Source identity**: `source.service` must match the producer registration bound to the
   token (`system:control-plane` may emit as control-plane; `agent:janet` may not —
   `source_mismatch`).
2. **Reserved namespaces**: `audit.*`, `attention.*`, `governance.*`, `task.*`, `card.*`,
   `console.api.*`, `delivery.*`, `bridge.*` accept only console-api-internal and registered
   trusted system producers. A forged `attention.resolved` or `audit.op` is rejected at the
   door, not filtered later.
3. **Scope ownership**: a producer emits only into scopes its grants allow (own
   `agent:<self>`; `fleet` if granted; `user:*`/`restricted:*` only with an explicit emitter
   grant — relation `editor` on the scope + producer registration).
4. **Severity cap** per producer capability (agents can't mint `p0` outside their own scope).
5. **Rate + registry caps**: per-producer emit rate, new-type registration rate (quarantine +
   curation proposal on breach), cardinality caps (schema bounds).

Producer failure rule: `/emit` unavailable ⇒ producers keep a **bounded local spool and retry
with the same emission id** (dedup makes this safe); on shed they drop oldest-debug-first and
emit `emissions.dropped` on recovery. Accepted (`202 {seq}`) = durable + fanned out.

### 4.4 Bridging as-built producers (fleet-bus aggregation)

Bridges are **per-box processes POSTing to `/emit`** (local buffering for free; the .14
console-api tail is only for .14-local sources). Bridges ride the same emit validation path as
everyone (scope-required, schema-validated, distinct `bridge` producer registrations) — no
direct lake writes. Delivery guarantees, per source:

| Source | Types | Guarantee |
| ------ | ----- | --------- |
| `data/fleet/<handle>.json` (per box) | `fleet.event.*` | **snapshot semantics, lossy by construction** (file = latest event; events between polls are lost) — documented; native manager/hook emit replaces it early in Phase 1 |
| manager heartbeat files | `agent.heartbeat` (state-change + ≥15s keepalive, **never 1:1 at 1s**), `agent.crashed`, `channel.lockout` | state-change exact; keepalive sampled |
| dispatcher card lifecycle | `card.*`, comms events | **read-only SQLite poll** (no triggers, no second writer — DP2); cursor on `updated_at_ms` + card fence |
| control-plane spool events | `governance.action`, `fleet.mode`, `discipline.nag`, `usage.report` | at-least-once from spool lines; deterministic ids dedup |
| `~/.claude/shared/system-outbox/` | `host.disk.pct`, `container.update_available`, `box.update_status_changed`, … (the bot-spam retirement path) | at-least-once; **the Matrix warning path is NOT decommissioned until `lake.disk.watermark` has fired in anger once** |
| tracker events table | `task.*`, `artifact.created` | at-least-once from the event log id cursor |

Bridge mechanics (normative): deterministic **UUIDv5 emission ids** (source+cursor/content
hash) so restarts cannot double-land; durable cursors, checkpointed transactionally with the
POST; `bridge.gap_detected` / `bridge.cursor_reset` emitted whenever loss is possible;
`bridge.source.unreachable` when a box goes dark (a dark box is a signal, not an absence).
Scope stamping: the narrowest scope serving the surfaces bound to that type (tiebreak rule).
**Comms emission mapping** (the Envelope/comms-log binding): types `comms.card | comms.rpc |
comms.mail`; dimensions `method, in_reply_to, recipient, requires_reply, thread`;
`source.agent` = sender; `subject` = recipient; bodies/output tails via `body_ref` (scope-
checked blob). Full session transcripts are **Phase 5** (bus-published by the per-user
manager), explicitly not before.

**Volume budget (acceptance gate, events/day at current fleet):** heartbeat keepalives ~40k ·
fleet events ~50-200k · host metrics ~40k (15s × 7 boxes × 6-8 series) · cards/tasks/comms
~5-20k · self-instrumentation (sampled) ~20k ⇒ **~0.2-0.3M rows/day** (NOT millions — the 1s
heartbeat is never bridged 1:1). Raw retention 30d ⇒ low-GB range; rollups carry the year.

## 5. Command plane

### 5.1 The op envelope — `POST /api/v1/op`

`schemas/op-call.schema.json` / `op-result.schema.json` (normative). Semantics:

- **Authorization = lane ∩ authz ∩ executor-liveness.** The router checks the Principal's lane,
  then the per-op `authz` rule (own / grant: relation on target scope resolved from args —
  `ops.json` is machine-readable on this), then the **gating executor's** liveness
  (`/executors` semantics; for spool-inlet executors = the manager's heartbeat freshness).
  `executor_unreachable` (retryable) = disabled-with-reason; `lane_denied`/`scope_denied`
  (not retryable) = hidden/denied; ops that can never exist on a target (agentless
  `updates.apply`) are captions, not disabled buttons.
- **Two-phase audit.** `audit.op.intent` (op, args-hash, principal, `outcome: attempted`)
  commits BEFORE dispatch — if that write fails, the op does not run (`audit_unavailable`;
  fail closed, Matrix is the command floor). `audit.op.outcome` (`ok|failed|executor_died`)
  commits on completion, linked by the op `id`. An executor that dies mid-op renders as
  attempted-without-completion, never as "ran". Read ops skip audit (the three `audit_seq:
  null` cases are enumerated in the schema).
- **Async executors.** Spool/RPC-dispatched ops return `status: "accepted"` (in-flight, NOT
  success); completion arrives as the op's declared `emits[]` type carrying the op id — the
  bus closes the loop. Synchronous ops return `status: "applied"`. The `agent.command`
  backchannel envelope **reuses the op id verbatim** as its envelope id, so N0.1 idempotent
  dedup composes end-to-end and a console retry can never double-restart. (The legacy Matrix
  `!command` path has a separate idempotency space — documented; manager-side dedup where
  feasible; the two paths are never fired together by the console.)
- **Lease-guarded task writes.** Agent callers supply `lease: {fence, claim_token}` on
  `task.update`/`task.close` transitions out of `doing` (tracker rejects `stale_fence` /
  `not_lease_holder` — the N0.1 fence rule preserved end-to-end); browsers never hold
  claim_tokens — human principals use `force: true` (audited; tracker clears the lease and
  increments the fence).
- **`dry_run`** (op-call flag): full validation + authz + liveness + intent audit, no effect —
  the test affordance for `testable: dry-run-only` ops. `fleet.mode` is `live-canary` with a
  written runbook (Phase 1 acceptance).
- **Undo** where declared; snackbar fires `undo: {op, args}` from the result.

### 5.2 The op catalog

[`ops.json`](ops.json) is **canonical** (validated by `schemas/op-catalog.schema.json`; the
summary table below and the frontend's ActionRows are generated from it — drift is a CI
failure). 74 ops across 22 namespaces; per-op: lane, `authz` (rule/relation/scope templates),
single gating executor, JSON-Schema args, effect, emits, confirm/destructive/undo/reason
flags, `human_only`, `testable`, phase, lineage. Spec-name drift lives in
`spec_name_aliases` (`terminal.open`→`term.watch`, `governance.pause`→`governance.action
{action: pause}`, `research`→`kb.research`, `dashboard.set-home`→`dashboard.set_home`).

Notable resolutions: `channel.reclaim` semantics defined (rightful manager re-asserts, fences
the contender; cross-host contender stood down via its own manager); `service.logs` is a
bounded snapshot in P0 (streaming shares the term-frame carve-out, §11); `delivery.resend` +
`dashboard.delete`/`dashboard.share` added; `task.dispatch` carries `needs[]` +
`interrupt_policy` (dispatcher still stamps `sender_class` and demotes spoofed interrupts);
`host.probe` targets only registered probe entries (`ssrf_rejected` otherwise);
`delivery.set_target` accepts only owner-bound Matrix addresses (`target_not_owned`).

**Propose-not-commit** (tiers with `propose_only`, §7.3): there are no `*.propose` op
variants. The op router transforms any mutating op call from a propose-only caller into a
tracker suggestion-queue entry and returns `{ok: true, status: "applied", result: {proposed:
true, proposal_task_id}}` — a stable shape; owners promote via the normal tracker flow.

### 5.3 The attention store

`schemas/attention-item.schema.json` (normative — creation rules enumerated there in full:
crashed/lockout heartbeats, p0 signals, blocker cards, review-ready transitions, requested
artifacts, dead-letters, security-critical updates, delivery failures). `fix_ops` carry
**pre-bound args** — the client never derives op args from `subject`. Mutations only via
`attention.ack/snooze/resolve` (idempotent), any channel, every mutation emits. Incident
collapse (`incident_key` = source+subject+window) + flap damping live here. The Signals
InterruptRecord ack path: `interrupt.fired` emissions carry `attention_id` in dimensions.

## 6. Library plane (Rev3, the one store)

Wire surface as before (items, grow-only typed links, hybrid search below-the-ranker
scope-filtered, provenance facets, holds/curation/promotion ops). Phasing, reconciled:
**Phase 1 ships the minimal items table** (dashboards, saved investigations, artifact/feed
projection) so `dashboard.*` ops are real in Phase 1; search + links + curation land Phase 2;
full Rev3 (CRDT prose, curation autonomy) remains its own effort. Tasks stay tracker-owned and
project in read-only; consumers never see the migration seam. Item `source_url`/`body_ref`
are validated at render/refetch time (no `javascript:`/internal-URL execution — Phase 2).

## 7. ReBAC scope + permission levels

### 7.1 Scope tags — as before (`user: | agent: | project: | fleet | restricted:`), flat (Rule 11).

### 7.2 Grants — `schemas/scope-grant.schema.json` (normative; `invalid_at > valid_at`
validator rule; relation `editor` on a scope doubles as the emit grant per §4.3). Enforcement:
scope-filter injection + Postgres RLS backstop (`security_invoker = on` on every view) +
op-router lane∩authz. Zookie comparison point: principal resolution checks the grant-set head;
WS re-fences on change (§4.1); bearer revocation is per-request and separate (§1.2).

### 7.3 Permission levels — tier rows `{name, authentik_group, default_relations,
propose_only}`, seeds owner/moderator/collaborator/guest; adding a level is an insert.
`propose_only` routes via the §5.2 transformation. Terminal stays human-only regardless of
tier (structural, not a grant).

## 8. Freshness windows (normative)

heartbeat ≤30s · fleet snapshot ≤90s · registry ≤90/300s · Matrix sync ≤120s · resource series
≤60s · box_update ≤2× cadence · bus heartbeat frame 15s (silent ≥90s ⇒ "Can't verify") · link
heartbeat ≤30s. Freshness sources include `lake:rollup` with `window_s` = rollup job cadence —
bucketed reads can't lie about rollup lag. "Everything is fine" = fresh bus heartbeat frame
AND ingest lag within windows AND fresh fleet data (positive evidence, all three).
Severity→label map (shared derivation, named once): `p0→P0, danger→P1, warn→P2, info→P3,
debug→(feed only)`. Blast-radius line derivation (attention.subject → host residents →
leases-under-30m) is a named shared derivation served pre-joined on the AttentionCard
(`fix_ops`-style, server-side).

## 9. Render contract + dashboard-assistant tool surface

As before (six tools = thin bindings of the planes), with board fixes: PanelSpec v2 regains
`encoding.color_palette` and enum `forecast.confidence`; top-level `suggestions` for
successful-answer follow-ups; type-conditional requirements (chart⇒`query_ref`, text⇒`prose`,
refusal⇒`refusal`). `dashboard.save` carries the **`branch` block** (`parent_dashboard_id,
parent_question, filters, selected_mark, assumptions` — the ExplorationGraph/BranchContext
lineage) and a board-level `time` range; `context.receive` payloads are SelectedMark-complete
(`element_kind, field?, value, datum?, query_ref?, entity_ref?`). The per-user assistant
session is Phase 5; the tool seam is fixed now.

## 10. Observability of the surface itself

Every request/op/emit is an emission per Rule 8 (with Rule 8's anti-recursion + sampling; the
`Authorization` header and `term.input` bodies are never captured). Glitchtip carries
*exceptions*; the lake carries *events* — one error, both places, by class not by duplication
(exception→Glitchtip + a `console.api.error` emission without the stack). Retention classes
are contractual: `audit.*`, `term.*`, `edge.*`, security events ≥1y (archived, never
blanket-purged); raw telemetry 30d; rollups 1y. `lake.disk.watermark` is a Phase 1 crack
source with an emergency retention-shrink runbook.

## 11. Out of scope for P0 (lands in the named phase)

`POST /ask` + engine internals (Phase 2) · `GET /graph` walk endpoint (Phase 2; edge *storage*
Phase 1) · doorman deep shapes (Phase 1 with `PetalNet/doorman`) · PTY + `service.logs` stream
framing (Phase 1, Terminal spec owns frames; audit-before-first-frame generalized in §5.1) ·
librarian autonomy (own effort) · per-user claude-code manager runtime + session transcripts
on the bus (Phase 5) · view registration governance (Phase 2).

## 12. Migration + failure notes

v0 consumers keep working throughout: bridges emit on their behalf; Matrix remains the
never-dark floor for commands and P0 alerts (not decommissioned until the lake watermark path
has proven itself); no as-built writer changes shape until its consumer is on the plane.
Bridges soak ≥1 week before any v0 consumer (cockpit fleet.js) switches off local files.
console-api is the **single seq writer**: upgrades are a brief planned gap (clients heal via
`since`); no blue/green needed at this scale. Lake down ⇒ ops fail closed
(`audit_unavailable`), emit spools client-side, surfaces go honestly stale. Rollback notes for
the two merged-app changes (control-plane persistence, box-agent envelope methods) ride their
Phase 1 PRs.
