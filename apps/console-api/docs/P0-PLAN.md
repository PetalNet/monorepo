# Console backend (second pass) — P0 plan

_console-backend Fable · 2026-07-12 · board-gate: this plan + the contract surface
([contracts/CONSOLE-CONTRACTS.md](contracts/CONSOLE-CONTRACTS.md)) are reviewed BEFORE any
service code. Brief: `/home/docker/console-backend-fable/CONSOLE-BACKEND-BUILD-BRIEF.md`._

## 1. What this pass builds (and why it exists)

The as-built Fleet+Manager backend (manager, control-plane, dispatcher, box-agent, matrix-channel
— all merged) has **no externalized query/command API**: reads are files + SQLite on local disks,
commands are Matrix `!commands`, governance state is in-memory, there is no pub/sub bus, and no
statistics substrate. The console UI specs are designed against the FINISHED backend. This pass
closes that gap: the four planes (Query / Command / Bus / Library), the statistics substrate +
engine (L1-L4), ReBAC, permission levels, and the dashboard-assistant runtime seam.

## 2. Stack pin

| Piece                  | Pin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| console-api service    | **TypeScript, Node 22, Fastify + ws, Drizzle ORM** — new pnpm-workspace app `apps/console-api` in `PetalNet/monorepo`                                                                                                                                                                                                                                                                                                                                                                                                   | Lab web stack is TS (tasks, citeseer, point/app); the L3 engine is a citeseer port (TS); CI + workspace exist; the fleet daemons stay Rust and meet the API at envelopes, not FFI |
| Lake + substrate store | **Postgres 16 + TimescaleDB 2.x + pgvector, dedicated container (`lab-lake`)**; `events` hypertable + **TimescaleDB continuous aggregates** (the rollup mechanism, pinned — vanilla PG has neither); rollup reads carry `freshness.source: lake:rollup` with `window_s` = job cadence; retention CLASSES (audit/term/edge/security ≥1y archived; raw telemetry 30d; rollups 1y); temp DBs for tests. **Precondition: free disk on .14 or mount the lake volume on another box BEFORE the container lands** (.14 at 89%) | Graphing brief pins Postgres+pgvector; hypertable/rollup language now has a real mechanism; RLS (`security_invoker=on` views, no fdw extensions) = the ReBAC backstop             |
| Bus                    | **Single serialized appender** in console-api assigns seq in durable-commit order; fan-out only after commit (no assignment/commit race); bounded per-subscriber queues + gap frames (backpressure is contracted, `bus-frame.schema.json`); `since` exclusive; retention horizon → resync_required. LISTEN/NOTIFY only if multi-instance                                                                                                                                                                                | One moving part; resume protocol is designed, not asserted; doctrine holds by construction                                                                                        |
| Bridges                | **Per-box bridge processes POSTing to `/emit`** (local buffering free; deterministic UUIDv5 ids + durable cursors; gap/cursor-reset/source-unreachable emissions; dispatcher = read-only SQLite poll, never triggers); heartbeats bridged as state-change + ≥15s keepalive, NEVER 1:1 at 1s; **volume budget ~0.2-0.3M rows/day is a Phase 1 acceptance gate**; Rust daemons gain native `emit()` over time (glitchtip.rs pattern; fleet-event native emit early — the snapshot file is lossy by construction)          | Zero as-built writer changes day one; every bridge guarantee is contracted (§4.4)                                                                                                 |
| Auth                   | Authentik forwardAuth via a **dedicated console-api middleware** (per-boot nonce, strip-set, full assist-auth.py parity); **hard precondition: close the shared `:80` `forwardedHeaders.trustedIPs` gap before serving** — this surface carries host.reboot/term.\*. Bearer tokens: vault keeps plaintext for re-issue (as-built CP4); console-api's verification table stores sha256 only; revocation checked per request                                                                                              | What the lab runs; closes the spool self-asserted-identity boundary INCLUDING the /emit producer side (emit-authz matrix §4.3)                                                    |
| Schemas/validation     | JSON Schema 2020-12 (contracts) ↔ zod (runtime) generated, ajv in CI validating examples                                                                                                                                                                                                                                                                                                                                                                                                                                | N0.1 precedent; frontend consumes the same schema files                                                                                                                           |
| Observability          | Glitchtip DSN-or-inert + `console.api.*` self-emissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Lab convention; the substrate is its own first customer                                                                                                                           |

## 3. Architecture (one diagram)

```text
                    ┌──────────────────────────── console-api (apps/console-api) ───────────────────────────┐
 browsers/agents ──►│  auth (authentik/bearer → Principal)                                                   │
   HTTPS + WS       │  Query plane ── stats.query (structured|sql-RO) ─┐        ┌── typed reads (/fleet, …)  │
                    │  Command plane ─ op router ─ audit-before-effect │        │                            │
                    │  Bus plane ──── WS subscribe (scoped) ◄─ fan-out ─┤        │                            │
                    │  Library plane ─ items/links/search              │        │                            │
                    └───────────┬───────────────┬─────────────────────┼────────┼────────────────────────────┘
                                │ envelopes     │ HTTP RPC            │        │
                    ┌───────────▼───┐  ┌────────▼─────┐        ┌──────▼────────▼──────┐
                    │ dispatcher /  │  │ tasks tracker │        │  lab-lake Postgres    │◄─ bridges (spools,
                    │ control-plane │  │ (single writer│        │  events + rollups +   │   fleet files, sys-
                    │ / managers /  │  │  canonical    │        │  semantic registry +  │   outbox, tracker
                    │ box-agents    │  │  helpers)     │        │  library + grants     │   events, card SQLite)
                    └───────────────┘  └───────────────┘        └───────────────────────┘
```

Command routing: `agent.*`/`channel.*` ops ride a new backchannel-rpc `agent.command` inlet to
the manager (spool now, doorman when it lands; Matrix stays the never-dark floor).
`governance.*`/`fleet.*` ride control-plane's existing envelope methods (+ a persistence fix:
grants/usage land in its SQLite so `/governance` survives restarts). `task.*` calls the tasks
app's canonical helpers over HTTP RPC (single-writer rule intact). `term.*` is a PTY streamer
in console-api shelling to tmux pipe-pane over ssh (TERM_ADMIN humans only).

## 4. Phase DAG (each node: board → build → PR → codex + adversarial review → merge → board)

- **P0 (this node)** — contracts + plan. Deliverable: this doc + CONSOLE-CONTRACTS.md + schemas
  - ops.json, merged; published to the gallery + tracker for the frontend Fable.
- **Phase 1 — query/command API.** console-api skeleton (auth incl. trustedIPs closure,
  Principal, op router with lane∩authz, **two-phase audit / command ledger**), lake
  (TimescaleDB) + emission ingest with the **emit-authz matrix** + serialized-appender WS bus
  - per-box bridges, **edge storage** (subject_kind + links materialized at ingest), typed
    reads incl. `/me` `/executors` `/roster` `/health`, **minimal Library items table**
    (dashboards real in Phase 1), tracker/dispatcher/control-plane/manager op paths (manager
    command inlet reusing op ids + control-plane persistence + `channel.reclaim`), attention
    store + rules, subscriptions + server-assembled digests + delivery ops, `lake.disk.watermark`
  - ingest-lag + native crack emitters (service-down probe runner may slip to 2), fleet.mode
    live-canary runbook. Test on temp DBs + disposable sub-agent managers, never live Janet;
    `dry_run` covers the rest.
- **Phase 2 — statistics substrate + engine (L1-L4).** Semantic-layer auto-derivation +
  catalog, registered-view governance (the join mechanism), RAG corpus (pgvector), `/ask`
  engine (citeseer port + 4 hardening moves), `GET /graph` walk endpoint, PanelSpec v2
  render + forecasting port, remaining crack emitters, Library search/links/curation wire
  surface.
- **Phase 3 — ReBAC.** Grants store + zookies, scope-filter injection + RLS, as-user
  enforcement in every plane, scope stamping audit of all emitters.
- **Phase 4 — permission levels.** Tier rows + Authentik group mapping, propose-not-commit
  routing (suggestion queue), per-resource grants + revocation, grant/revoke ops + audit.
- **Phase 5 — dashboard-assistant runtime seam.** Per-user claude-code manager specialization
  (Fleet Manager lineage), session registry, the six tools as an MCP server bound to the
  planes (tool surface research /task/704 folds in here), `context.receive` path.

Ordering note: ReBAC _shapes_ (scope on every emission, Principal.scopes, grants schema) are
P0-fixed and enforced from Phase 1's first insert — Phase 3 hardens enforcement + tooling; it
does not retrofit scope onto unscoped data. No facades: every phase's ops drive the real
executors end-to-end before merge.

## 5. Coordination with the frontend Fable

The frontend build Fable does not exist yet; the P0 contract IS the seam. On merge: publish the
contract as a gallery artifact (`console-backend-contracts`), file the tracker task, and drop a
pointer in `/home/docker/console-backend-fable/CONTRACT-SURFACE.md`. Contract changes after
publication: additive = PR + note; breaking = version bump + migration note + a tracker ping.
When the frontend Fable needs something not covered, it files a tracker task; serving it takes
priority over the current phase node (per brief).

## 6. Risks / open questions (board input wanted)

1. **Bus single-instance**: accepted (LAN scale); backpressure + gap frames + resync are now
   contracted (bus-frame schema), console-api is the single seq writer (upgrade = brief
   planned gap, clients heal via `since`), and blast radius is stated plainly in §1 of the
   contract: console-api down = surfaces honestly dark, Matrix stays the command floor.
   systemd `Restart=always` + `WatchdogSec` + `MemoryMax` against `/health`.
2. **Manager command inlet transport**: spool file next to the heartbeat (matches lab idiom,
   works today) vs waiting for doorman RPC. Plan: spool now behind the same `agent.command`
   method shape doorman will carry — swap transport, not contract.
3. **Governance persistence**: adding SQLite persistence to control-plane changes a merged
   app. Scoped as additive (a `grants`/`usage` table + rehydrate-on-boot), reviewed like any
   node, **with a rollback note in its PR** (drop-table + revert = old behavior, state was
   always reconstructible from usage.report flow). Alternative (console-api reconstructs from
   spool events) duplicates truth — rejected.
4. **`updates.*` / `service.*` executor**: box-agent source was deleted (binary only, PR #149
   history) and it currently handles task cards, not service ops. Phase 1 restores the source
   from git history and extends its envelope methods (handler layer only; rollback note in
   its PR). box_update collector lives at `/home/docker/update-collector` (verified);
   `packages[]`/`vulns[]` raw detail is NEW collector work behind `raw_ref`.
5. **Postgres container**: .14 disk at 89% — **the volume decision (free space or mount the
   lake elsewhere) is a hard precondition before the container lands** (stack pin). Volume
   budget ~0.2-0.3M rows/day (acceptance gate); retention classes contractual (§10);
   `lake.disk.watermark` crack source + emergency retention-shrink runbook in Phase 1;
   system-outbox/Matrix warning path not decommissioned until the watermark has fired in
   anger once. Bridges soak ≥1 week before v0 consumers switch off local files.
6. **Library plane before the librarian exists**: the wire surface is pinned now; **Phase 1
   ships the minimal items table** (dashboards, artifacts, feed projection — so `dashboard.*`
   is real in Phase 1); Phase 2 adds search/links/curation. Full Rev3 (CRDT, curation
   autonomy) remains its own effort.
