# Phase 1 — query/command API: implementation design (board round 1 applied)

_console-backend Fable · 2026-07-13 · board-gated (codex + adversarial security review;
architect lens folded into codex — see DECISIONS-PHASE1.md). Contract (merged, normative):
[contracts/CONSOLE-CONTRACTS.md](contracts/CONSOLE-CONTRACTS.md) + ops.json + schemas/. Scope:
[P0-PLAN.md](P0-PLAN.md) §4 Phase 1. This document pins HOW; the contract is WHAT._

## 1. Node breakdown (each: build → PR → codex + adversarial review → merge; SERIAL where noted)

| Node                                                                     | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Touches                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **N1a — service core + lake + bus**                                      | console-api skeleton (Fastify, auth→Principal, /health, /me), lake DDL + **ordered** migrations (§3), emission ingest (`/emit`, `/emit/batch`) with emit-authz matrix + secret scrubber + **transactional dedup** (§5), serialized appender, WS bus (**exact-cutover** design §4), `stats.query` structured mode + `/catalog`, self-instrumentation + Glitchtip. **Includes the bootstrap seed migration + first-token CLI (§7)** — nothing can emit or be administered without it. | new app only                                                                           |
| **N1b — bridges + typed reads**                                          | per-box bridge binary (`console-bridge`, Rust, ureq/glitchtip.rs pattern; UUIDv5 ids, durable cursors, gap/unreachable emissions), .14-local tails (system-outbox, tracker events, dispatcher read-only poll), **the command-completion outbox tail** (§6 — the loop N1c's verification needs), all typed entity reads incl. `/roster` `/executors` `/workers`                                                                                                                      | new app + new tool crate                                                               |
| **N1c — command plane + Rust inlets** (depends on N1b's completion tail) | op router (lane∩authz, template resolution, **transactional two-phase ledger** §6, dedup, dry_run, undo), tracker op path (**signed principal assertion** §8 + the tracker patch), dispatcher ops (spool), **manager `agent.command` inlet + result outbox** (§8, config+example+schema), **control-plane persistence + governance/fleet command path** (§8), **box-agent restore + `service.*`/`updates.*`/`host.*` argv-exec methods** (§8)                                       | manager, control-plane, box-agent, **tracker** (scoped patches, rollback notes per PR) |
| **N1d — attention + subscriptions + delivery**                           | attention store + 8 creation rules + incident collapse/damping, standing subscriptions + server-assembled digests, delivery ops (Matrix via a **custody-pinned** bot token §8, receipts, cocoon, send-time grant re-check), `lake.disk.watermark` + ingest-lag emitters, SQL query mode (RO-role hardening §3), fleet.mode live-canary runbook                                                                                                                                      | new app + config                                                                       |

**Ordering (corrected):** N1a → N1b → N1c → N1d, strictly serial on the completion loop
(N1c's end-to-end op verification observes completions ingested by N1b). Within a node, sub-PRs
may parallelize. `channel.reclaim` is **deferred out of N1c** to a follow-up node bundled with
the real single-owner lock work (today's lock is a stub — §8); its catalog entry ships, the op
returns `executor_unreachable` until the lock lands (honest disabled-with-reason, not a facade).

## 2. console-api module layout (`apps/console-api/src`)

```text
server.ts            Fastify boot, routes, ws upgrade, health
auth/                forwardAuth verify (nonce, strip-set, header canon), bearer verify
                     (sha256 table, per-request revocation), principal resolve + zookie,
                     principal-assertion signer (§8)
db/schema.ts         Drizzle + raw SQL migrations (ordered §3): events (hypertable), edges,
                     semantic_registry, producer_registrations, command_ledger,
                     attention_items, subscriptions, delivery_config, grants, tiers,
                     items_min (dashboards/artifacts), blobs
bus/appender.ts      THE single serialized appender: validate → authz → scrub → INSERT
                     (ON CONFLICT dedup, committed) → seq → fan-out (post-commit only)
bus/ws.ts            subscribe registry, scope intersection, bounded queues + gap frames,
                     exact replay/live cutover (§4), re-fence on grant change
ingest/authz.ts      emit-authz matrix (source binding, reserved + emits[]-executor rule,
                     scope ownership, severity caps, rate/new-type caps, quarantine)
ingest/scrubber.ts   secret deny-list (claim_token, Authorization, token-shaped)
query/structured.ts  semantic validation (meta.fields agg honesty), bucket/fill/coverage,
                     view registry (`events`, `roster`, ...), scope injection
query/sql.ts         RO-role executor (SET LOCAL app.scopes, search_path pin, SET-block, timeout)
ops/router.ts        ops.json-driven: lane∩authz, template resolver, two-phase ledger, dedup,
                     dry_run
ops/executors/       tracker.ts, dispatcher.ts, manager.ts, controlplane.ts, boxagent.ts,
                     library.ts, local.ts (attention/subscription/delivery/signal)
reads/               typed entity handlers (read-envelope, per-item observed_at, pagination)
attention/           rules engine (bus-driven), incident keys, flap damping
delivery/            digest assembler (windows), matrix sender, receipts, cocoon, send-time recheck
```

`ops.json` is loaded as runtime config AND compiled-in as a versioned asset; the router asserts
the loaded catalog's content-hash matches the build's at boot (catalog drift = fail-loud start,
never a router that silently diverges from the published contract).

## 3. Lake DDL + the ordered security migration

`events`: `seq BIGSERIAL` (appender-assigned, commit-ordered), `id UUID UNIQUE`,
`type, ts, received_at DEFAULT now(), source_service/host/agent, subject, subject_kind,
severity, action, task_id, scope, dimensions JSONB, measures JSONB, links JSONB, body_ref,
meta JSONB` — TimescaleDB hypertable on `received_at`; retention by type-class
(audit/term/edge/security exempt ≥1y); continuous aggregates per registered rollup.
`edges` materialized from `links` at ingest. `command_ledger`:
`(principal, op_id) PK, op, args_hash, body_hash, intent_seq, outcome_seq, status
(accepted|applied|failed), result_scrubbed JSONB, created_at, updated_at`.
`blobs`: `(id PK, scope, bytes, created_at)` — **scope-checked on fetch by the same RLS as
events** (M2).

**One ordered migration, no window (M1, codex P1):**

1. `CREATE ROLE console_migrator` (owns objects), `console_app` (non-BYPASSRLS runtime role),
   `console_ro` (read-only SQL mode).
2. create each base table → `ALTER TABLE … ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY`.
3. policy: `USING (scope = ANY (string_to_array(current_setting('app.scopes', true), ',')))`
   for `console_app` and `console_ro`; the runtime sets `SET LOCAL app.scopes = '…'` per
   transaction from the Principal (no scopes set = no rows).
4. `REVOKE ALL … FROM console_ro; GRANT SELECT` on the scoped views only.
5. views created `WITH (security_invoker = on)` AFTER their base policies exist.
6. assert no `dblink`/`postgres_fdw`/`file_fdw` extension present.
   CI (extends §9): every base table has RLS enabled+forced; every view is `security_invoker`;
   `console_ro` cannot read a row outside a set scope (isolation test).

## 4. Bus: appender + exact WS cutover

The appender is one async queue; a single writer assigns `seq` only after the row commits, and
fan-out reads happen strictly post-commit in `seq` order (no assignment/commit race). WS
subscribe cutover (codex P1):

1. register a live buffer for the sub BEFORE reading any boundary (buffers post-`b` events).
2. capture `b = committed seq head` (the appender's last committed seq).
3. `ack {replay_through_seq: b}`; replay lake rows `seq <= b` matching pattern∩scope.
4. flush the live buffer for `seq > b` exactly once (dedup against replay by seq), then stream live.
   Grant change → re-fence: drop the sub's scope snapshot, re-resolve, tear down subs whose scope
   narrowed. `since` below retention → `resync_required {oldest_seq}`. Bounded per-sub queue;
   overflow → `gap {from_seq,to_seq,reason:backpressure}`, client heals via `since`.

## 5. Emission dedup (transactional, codex P1)

`INSERT … ON CONFLICT (id) DO NOTHING RETURNING seq`. On a returned row: assign fan-out. On
conflict (no row): `SELECT seq FROM events WHERE id = $1` and return that seq with
`{duplicate: true}`, **no fan-out, no re-authz side effects**. The uniqueness check is the
commit; validation/authz run before the INSERT but a duplicate short-circuits to the original
seq. Idempotent `202` regardless of auth/registration changes between attempts.

## 6. Two-phase audit + durable async completion (codex P0/P1, security H1)

**Ledger, transactional:** before dispatch, in ONE txn: write `audit.op.intent` emission
(via the appender) AND the `command_ledger` row `status=accepted, intent_seq`. If that txn
fails → op does not run (`audit_unavailable`, fail-closed). Retry of an accepted `(principal,
op_id)` returns the recorded result and NEVER redispatches.

**Durable completion loop** (replaces "seen-file"): each spool-inlet executor keeps a durable
inbox+result store keyed by op id (SQLite for the Rust apps): claim envelope atomically →
execute → persist result → the executor emits its completion (`agent.lifecycle`, etc.) **under
its own producer registration** (the bridge tailing that executor's outbox carries a
registration DELEGATED to emit that executor's completion types — satisfying §4.3 rule 6 that
completions come only from the gating executor's identity; the bridge is that identity's wire
mouth, not a separate forger). console-api observes the completion emission carrying the op id
and transitions the ledger `accepted → applied|failed` + writes `audit.op.outcome`. Executor
death before outcome → ledger stays `accepted` past a deadline → rendered
attempted-without-completion (never "ran").

## 7. Bootstrap / seeding (codex P0, security H3) — the chicken-and-egg break

A `seed` migration + a one-shot CLI, run once at deploy, out of band:

- migration inserts: `owner` grant for `parker` on `fleet` + `user:parker`; `moderator` for
  `eli`; per-agent `operator` grants on `agent:<self>`; the `producer_registrations` rows for
  each bridge/executor (source identity + allowed type-prefixes incl. delegated completion
  types); tier rows (owner/moderator/collaborator/guest).
- `console-api mint-token <subject> [--scopes …]` CLI: mints a bearer → vault plaintext (CP4
  re-issue) + console-api verification table sha256; prints once. First tokens for parker/eli
  (browser uses Authentik, but agents + bridges need bearers) and each bridge/executor minted
  here. This is the only path that writes producer_registrations/grants outside a running
  authorized session.

## 8. Rust + tracker patches (scoped, rollback-noted per PR)

- **manager** (`apps/manager`, config is `deny_unknown_fields` — codex P1): add BOTH
  `command_spool_dir` and `result_outbox_dir` to `Config`, `config.example.json`, and the
  contract schema (schema_version-aware; absent = feature off = rollback). Tick drains
  `command_spool_dir/*.json` (backchannel-rpc `method:agent.command`, envelope id = op id),
  durable dedup (SQLite, not seen-file), maps to existing `handle_command` inputs, writes a
  result envelope to `result_outbox_dir`; the bridge emits the `agent.lifecycle` completion.
  **`channel.reclaim` NOT in this node** (lock is a stub, `state.rs`) — deferred with the real
  lock work.
- **control-plane**: concrete migration for `usage, grants, tiers, last_actions, status_since,
fleet_mode` (persist all governance state, not just usage/grants, so edge-trigger suppression
  survives restart — codex P1) + rehydrate-on-boot; a DISTINCT authenticated command inlet for
  `governance.*`/`fleet.mode` (the existing inlet only takes `agent.capacity`/`usage.report`),
  same spool-perms discipline. DROP tables = rollback.
- **box-agent** (restore from PR #149 history): `service.restart/stop/logs`,
  `updates.check/apply`, `host.reboot`, `worker.inventory` as envelope methods. **argv exec, no
  shell** (mirror `worker.rs:123-134`: program is fixed, service/box name is a single value arg
  matched EXACT against an allowlist, no interpolation — security H4). `updates.apply` verifies
  the box_id+packages against a console-api approval token carried in the envelope (not a bare
  spool drop — H1/L2). Handler-layer only.
- **tracker** (`/home/docker/tasks`, TS — security H2, NEW in scope): accept an internal-only
  `X-Console-Principal` signed assertion (short-lived, signed by console-api's key, verified
  against its public key) so a console-originated write records the true principal instead of
  collapsing to the service token's `agent_name`. Additive route guard; absent header = today's
  behavior (rollback).

**Spool trust boundary (security H1):** every command spool + outbox dir is `0700`, owned by
the console-api service user, never group/world-writable — documented per inlet. This is the
control against a forged action envelope (the completion-emit rule stops a forged _completion_,
not a forged _action_); it is explicitly the doorman precondition, stated as residual trust.
Allowlist + token-custody files (box-agent allowlist, Matrix bot token, glitchtip DSN) are
service-user-owned `0600`/root `0644`, never agent-writable (H4/M3), via
`/home/docker/.claude/shared/` like the existing token/DSN convention.

## 9. Deploy + test

- **Dev/test**: `timescale/timescaledb:latest-pg16` TEMP containers (per-run, tmpfs); disposable
  manager on a scratch tmux session + throwaway handle for `agent.*`; temp tracker DB — the
  harness **fails closed if `TASKS_DB_PATH` is unset or resolves to a live path** (default is
  live — security M4). Test Matrix uses a dedicated test-only bot token + room, never the prod
  delivery token (security L1); `delivery.set_target`'s owner-bound check prevents addressing a
  real user. vitest (TS) + `cargo test` (patches) + ajv (format-assertion on) validating every
  schema example and the generated §5.2 table.
- **Catalog-driven test matrix (codex P2):** a test generated per `ops.json` entry — every op
  exercised end-to-end on disposables, or via `dry_run` for `dry-run-only`, or the written
  runbook for `live-canary`; the `testable` field IS the checklist, CI asserts full coverage.
- **Contract-critical negatives/races (codex P2, security):** replay-boundary concurrency;
  duplicate emit + `id_reused`; intent-write-failure → fail-closed; executor death before
  outcome; re-fence + send-time grant revocation; RLS cross-scope isolation; `emits[]` forgery
  rejected; forged-spool-envelope rejected by perms; each Rust inlet restart/retry idempotent.
- **Prod (after the BLOCKERS.md disk + trustedIPs decisions)**: systemd (`Restart=always`,
  `WatchdogSec` on /health, `MemoryMax=2G`), Traefik + dedicated forwardAuth middleware,
  Glitchtip DSN, bridges soak ≥1wk before any v0 consumer switches off local files.

## 10. Acceptance gates (from the P0 + Phase-1 boards)

Volume within budget on the soak · no fdw + `security_invoker` + RLS-forced verified by CI
against the temp lake · isolation test (`console_ro` can't cross scope) · seed migration +
mint CLI produce a working parker/eli/agent/bridge identity set · every op path exercised
(catalog matrix) · the negatives/races above all covered · `lake.disk.watermark` fires in a
temp-volume rehearsal · fleet.mode runbook written · rollback notes in all four
manager/control-plane/box-agent/tracker PRs · forged-envelope + forged-completion both rejected
in tests.
