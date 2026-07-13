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

| Piece | Pin | Why |
| ----- | --- | --- |
| console-api service | **TypeScript, Node 22, Fastify + ws, Drizzle ORM** — new pnpm-workspace app `apps/console-api` in `PetalNet/monorepo` | Lab web stack is TS (tasks, citeseer, point/app); the L3 engine is a citeseer port (TS); CI + workspace exist; the fleet daemons stay Rust and meet the API at envelopes, not FFI |
| Lake + substrate store | **Postgres 16 + pgvector, dedicated container (`lab-lake`)** on .14; `events` table partitioned by day + continuous rollups; temp DBs for tests | Graphing brief pins Postgres+pgvector; isolation from the live tasks SQLite; citeseer lineage is Postgres; RLS = the ReBAC backstop |
| Bus | **In-process fan-out inside console-api over the durable lake write** (accept = durable + fanned out; WS subscribers scope-filtered; `since` replay from the lake seq). Postgres LISTEN/NOTIFY only if/when console-api goes multi-instance | One moving part; bus/lake share a seq so resume is gap-free; doctrine (bus=signals, lake=data) holds by construction |
| Bridges | Spool/file tail bridge in console-api (fleet events, heartbeats, system-outbox, tracker events) + SQLite-poll for dispatcher cards; **Rust daemons gain a tiny native `emit()` (ureq POST) over time** — glitchtip.rs is the pattern | Zero as-built writer changes to get on the bus day one; native emit replaces bridges incrementally |
| Auth | Authentik forwardAuth + nonce header-trust (assist pattern) for humans; bearer tokens (TokenAuthority lineage, sha256 at rest) for agents | What the lab runs; closes the spool self-asserted-identity boundary at the API layer |
| Schemas/validation | JSON Schema 2020-12 (contracts) ↔ zod (runtime) generated, ajv in CI validating examples | N0.1 precedent; frontend consumes the same schema files |
| Observability | Glitchtip DSN-or-inert + `console.api.*` self-emissions | Lab convention; the substrate is its own first customer |

## 3. Architecture (one diagram)

```
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
  + ops.json, merged; published to the gallery + tracker for the frontend Fable.
- **Phase 1 — query/command API.** console-api skeleton (auth, Principal, op router,
  audit-before-effect), lake + emission ingest + WS bus + bridges, typed reads, tracker/
  dispatcher/control-plane/manager op paths (incl. the manager command inlet + control-plane
  persistence + `channel.reclaim`), attention store + rules, subscriptions + delivery ops.
  Test on temp DBs + disposable sub-agent managers, never live Janet.
- **Phase 2 — statistics substrate + engine (L1-L4).** Semantic-layer auto-derivation +
  catalog, RAG corpus (pgvector), `/ask` engine (citeseer port + 4 hardening moves: semantic
  grounding, RAG, dry-plan validation, execution-guided self-heal ×3), PanelSpec v2 render
  contract + forecasting port, native crack-source emitters + probe runner, Library search
  (items/links/search wire surface).
- **Phase 3 — ReBAC.** Grants store + zookies, scope-filter injection + RLS, as-user
  enforcement in every plane, scope stamping audit of all emitters.
- **Phase 4 — permission levels.** Tier rows + Authentik group mapping, propose-not-commit
  routing (suggestion queue), per-resource grants + revocation, grant/revoke ops + audit.
- **Phase 5 — dashboard-assistant runtime seam.** Per-user claude-code manager specialization
  (Fleet Manager lineage), session registry, the six tools as an MCP server bound to the
  planes (tool surface research /task/704 folds in here), `context.receive` path.

Ordering note: ReBAC *shapes* (scope on every emission, Principal.scopes, grants schema) are
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

1. **Bus single-instance**: in-process fan-out means one console-api instance for now.
   Accepted (LAN scale, ~10s of subscribers); LISTEN/NOTIFY is the escape hatch. Right call?
2. **Manager command inlet transport**: spool file next to the heartbeat (matches lab idiom,
   works today) vs waiting for doorman RPC. Plan: spool now behind the same `agent.command`
   method shape doorman will carry — swap transport, not contract.
3. **Governance persistence**: adding SQLite persistence to control-plane changes a merged
   app. Scoped as additive (a `grants`/`usage` table + rehydrate-on-boot), reviewed like any
   node. Alternative (console-api polls spool events and reconstructs) duplicates truth — rejected.
4. **`updates.*` / `service.*` executor**: box-agent source was deleted (binary only, PR #149
   history) and it currently handles task cards, not service ops. Phase 1 restores the source
   from git history and extends its envelope methods. Risk: scope creep — box-agent changes
   are kept to the envelope handler layer.
5. **Postgres container on .14**: disk at 89%. Lake retention/rollup policy is part of Phase 1
   acceptance (raw events 30d, rollups 1y — tunable, agent-malleable config).
6. **Library plane before the librarian exists**: the wire surface is pinned now; Phase 2
   implements items/links/search minimally (dashboards, artifacts, feed projection) so the
   frontend binds once. Full Rev3 (CRDT, curation autonomy) remains its own effort.
