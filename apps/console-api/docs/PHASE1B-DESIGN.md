# Phase 1 · N1b — bridges + typed reads: detailed design

_console-backend Fable · 2026-07-13 · board-gate: reviewed before code (codex + adversarial
review). Builds on N1a (merged). Contract: [contracts/CONSOLE-CONTRACTS.md](contracts/CONSOLE-CONTRACTS.md)
§3.3 (typed reads), §4.4 (bridges), entity schemas in `contracts/schemas/entities/`._

## 1. The read-source decision (lake-projection vs source-of-truth)

The contract (§3.3) says typed reads "are views over the lake + sources of truth." N1b pins
which is which — the load-bearing N1b call:

| Read | Source | Why |
| ---- | ------ | --- |
| `/fleet`, `/heartbeats`, `/registry`, `/workers`, `/governance`, `/cards`, `/box-updates` | **lake current-state projection** (§2) | these are bridged emissions; "latest per entity" is the natural read; per-item `observed_at` falls out; renderer-agnostic |
| `/tasks`, `/leases`, `/agents` | **tracker, read-only** (single-writer rule — the tasks app owns these) | never project a single-writer store into a second store; read the truth |
| `/roster` | **join**: tracker `/agents` × lake current-state (fleet/heartbeat/registry/governance) × tracker `/leases` | one read, server-side join (contract §3.3) |
| `/executors` | **derived** from lake registry + heartbeat current-state + service probes | the ActionRow pre-flight liveness |
| `/dashboards` | **Library items_min** (minimal table, contract §6 Phase-1) | dashboards are Library items |
| `/edge/registry`, `/edge/sessions` | **lake current-state** (doorman emissions, bridged) | doorman deep shapes are Phase-1 formalization |

Rationale: bridged, high-churn observational state → lake projection (one door, everything-is-a-
statistic, honest freshness). Authoritative single-writer records (tracker) → read the source,
never re-project (avoids split-brain). The frontend sees one read surface either way.

## 2. Current-state projection

A `current_state` table upserted by a **projector** that subscribes to the bus (in-process in
console-api, reusing the appender's fan-out): `(kind, id) PK, scope, state jsonb, observed_at,
seq)`. On each bridged emission of a state-bearing type, the projector upserts the latest state
for that entity keyed by `(subject_kind, subject)` — guarded by `seq` (a lower seq never
overwrites a higher, so out-of-order never regresses state). RLS-scoped like events. Typed reads
are `SELECT state, observed_at FROM current_state WHERE kind = $1` (RLS filters scope), shaped to
the entity schema. Derivations the contract names (offline >90s, liveness 90/300s) stay
consumer-side — the read serves raw `observed_at`, never a pre-derived `offline`.

Projection rules (which emission type → which entity kind/state): `fleet.event.*` → agent
fleet-state; `agent.heartbeat` → manager heartbeat; `agent.capacity`/registry → registry;
`governance.action`/`usage.report` → governance; `card.*` → card; `box.update_status_changed` →
box-update; `fleet/<h>.subagents` → worker. The map is a small table, extended as bridges land.

## 3. The bridge binary (`console-bridge`, Rust)

A small per-box Rust binary (reuses the dispatcher's `glitchtip.rs`/`ureq` pattern; own crate
`apps/console-bridge`). Each bridge instance tails one or more as-built sources and POSTs
emissions to console-api `/emit` with a bearer minted for its `bridge:<box>` registration.

- **Deterministic ids** (contract §4.4): UUIDv5 over `(source_path, cursor|content-hash)` so a
  restart cannot double-land history.
- **Durable cursors**: a small local SQLite/file cursor per source, checkpointed *after* the POST
  is accepted (at-least-once; dedup makes it exactly-once in the lake).
- **Gap/unreachable signals**: `bridge.gap_detected` / `bridge.cursor_reset` when loss is
  possible; `bridge.source.unreachable` when a source goes dark (a dark box is a signal, not an
  absence).
- **Sources** (per §4.4 table): `data/fleet/<handle>.json` (snapshot-lossy, documented — native
  emit replaces it), manager heartbeat files (state-change + ≥15s keepalive, NEVER 1:1 at 1s),
  `~/.claude/shared/system-outbox/` (bot-spam retirement), tracker events table (task.*),
  dispatcher card SQLite (read-only poll on `updated_at_ms` + fence). Scope stamped narrowest-
  serving per type.

.14-local sources (system-outbox, tracker events) tail from a bridge co-located with console-api;
remote boxes run their own `console-bridge` (local buffering when console-api is down — a per-box
process, per the board's H4 fix, not a central ssh-tail).

## 4. The command-completion outbox tail (the loop N1c needs)

N1c's op verification depends on observing completion emissions. N1b builds the **completion
tail**: the manager/control-plane/box-agent write a result envelope to a `result_outbox_dir`; the
box's `console-bridge` tails it and emits the completion (`agent.lifecycle`, etc.) **under the
executor's delegated producer registration** (so §4.3 rule 6 holds — completions come only from
the gating executor's identity, the bridge is its wire mouth). This is the seam N1c's ledger
transitions read; N1b lands the tail + the delegated registrations, N1c lands the op router that
consumes it.

## 5. Module layout (additions to `apps/console-api/src`)

```text
projector/index.ts    subscribes to fan-out, upserts current_state (seq-guarded)
reads/entities.ts     typed-read handlers (current_state → entity schema; read-envelope + pagination)
reads/tracker.ts      read-only tracker access (tasks/leases/agents) via the tasks HTTP read API
reads/roster.ts       the server-side join
reads/executors.ts    liveness derivation
db/schema (migration) current_state, items_min, projection_map
```
```text
apps/console-bridge/  (new Rust crate) — tail sources, POST /emit, cursors, gap/unreachable
```

## 6. Test plan (disposables, never live Janet)

- **Projector**: feed synthetic bridged emissions (out of order, duplicates) → assert
  current_state holds the highest-seq state per entity; RLS scopes the reads.
- **Typed reads**: seed current_state + a temp tracker SQLite (fail-closed on unset TASKS_DB_PATH)
  → assert each entity read matches its schema + pagination + per-item observed_at.
- **Bridge**: a temp source file + a stub /emit → assert deterministic ids (restart = no
  duplicates in the lake), cursor checkpoint-after-accept, gap/unreachable emissions on
  torn/absent source.
- **Completion tail**: write a result envelope → bridge emits the completion under the delegated
  registration → assert it lands and an unauthorized producer is rejected (forgery blocked).
- **Roster/executors**: join correctness + liveness derivation windows.

## 7. Acceptance
Every typed-read entity schema round-trips; projector is seq-monotonic + RLS-scoped; bridge is
exactly-once under restart with honest gap signals; completion tail lands under the correct
identity and rejects forgery; tracker reads never write; all on temp DBs/containers.
