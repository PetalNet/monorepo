# Lab Console — Contract Surface (P0)

_Branch `feat/console-p0-contracts` · console-backend Fable, 2026-07-12 · REVIEWABLE SPEC ONLY —
no service code in this node. This is the contract the console FRONTEND builds against and the
work list the console-backend phases implement. Machine-readable schemas: [`schemas/`](schemas/)
(JSON Schema draft 2020-12). Grounded in: the console specs (`console-fable/specs/src/`, esp.
`00-foundations` §6), WAYFINDER-DECISIONS.md (30 decisions), SYSTEM-MAP-as-built.md, the N0.1
contracts (`apps/manager/docs/contracts/`), and GRAPHING-BACKEND-BRIEF.md (L1-L4)._

The console binds to **four planes**. This document is the canonical definition of each plane's
wire contract: shapes, endpoints, semantics, and the mapping from every contract to the as-built
shape it formalizes. Where the UI specs and this document disagree, the specs' *requirements* win
and this document has a bug; where this document and an implementation disagree, this document
wins and the implementation has a bug.

## 0. Rules (inherited from N0.1, extended)

1. **Versioned.** Every instance carries `schema_version` (integer, `const`-pinned per schema).
   Additive optional fields = same version; rename/remove/retype/enum-meaning change = bump + a
   migration note here.
2. **OS-neutral, renderer-agnostic.** No contract requires a POSIX-ism, a DOM, or this frontend.
   Every read is a plain typed read or subscription; the spatial view, Godot, agents, and `curl`
   are equal consumers.
3. **Timestamps.** RFC 3339 UTC strings (`format: date-time`) in all NEW contracts. Epoch fields
   appear only in as-built shapes passed through (heartbeat), and are named `*_epoch`.
4. **Identity.** Agent handles canonical lowercase (`^[a-z0-9][a-z0-9._-]*$`); hosts canonical
   `.N` form. Producers normalize; consumers may reject non-canonical.
5. **Tracker ties.** `task_id` rides every contract whose activity belongs to a task.
6. **Secrets.** `claim_token` and bearer tokens never reach a browser, a log line, or the bus.
   Viewer-bound lease projections are `leasePublic` only.
7. **Caller identity is server-stamped.** Nothing trusts a client-asserted principal, scope,
   `sender_class`, or capability lane. The API authenticates, then stamps.
8. **Everything emits, everything lands** (/task/710 + everything-is-a-statistic). Every
   occurrence emits a typed event unconditionally (zero subscribers is normal) AND persists as a
   queryable statistic in the lake. Bus = signals; lake = data. Durable data never lives only in
   the bus.
9. **Named-op symmetry** (/task/683). Every mutation is a named op, identical for humans and
   agents, capability-gated, audited. No op → no button. UI-only actions are contract violations.
10. **Freshness is computed, never trusted.** Every read carries freshness metadata; consumers
    derive staleness client-side against the windows in §8. Positive evidence is required for
    "fine"; silence never renders as health.
11. **ReBAC below the tools** (/task/706). Every statistic, signal, and item carries a scope.
    Every query runs AS the caller. Enforcement lives in the substrate and the query layer,
    never in a UI filter. What you cannot see does not arrive.

## 1. The four planes

| Plane   | Contract                                                      | Transport                          | Today's shape it formalizes |
| ------- | ------------------------------------------------------------- | ---------------------------------- | --------------------------- |
| Query   | `stats.query` as-user + typed entity reads, freshness metadata | HTTPS JSON (`POST /api/v1/query`, `GET /api/v1/<entity>`) | tasks.db rows, heartbeat.json, `data/fleet/*.json`, dispatcher SQLite, capacity SQLite, box_update rows, term_audit |
| Command | Named ops, 1:1 with UI actions, capability-gated, audited      | HTTPS JSON (`POST /api/v1/op`)     | Matrix `!commands`, spool envelopes, governance actions, token mint/rotate, tracker mutations |
| Bus     | Scoped subscribe over typed signals; unconditional emit        | WebSocket (`/api/v1/bus/ws`) + HTTPS emit (`POST /api/v1/emit`) | fleet-event stream, backchannel-rpc events, dispatcher card lifecycle, the Matrix bot-spam this retires |
| Library | Rev3 item + link API: hybrid search, typed links, provenance, curation | HTTPS JSON (`/api/v1/library/*`)   | tasks / artifacts / feed_items / projects tables converging into the one store |

One service owns the surface: **`console-api`** (new app, `apps/console-api`). It is a gateway +
substrate, not a re-implementation of the fleet: commands route to their real executors
(manager, dispatcher, control-plane, box-agent, tasks tracker, librarian), reads serve from the
lake and the sources of truth. The dashboard-assistant tool surface (§9) is a thin binding of
these planes.

### 1.1 Base protocol

- Base URL `https://console-api.petalcat.dev/api/v1` (LAN + edge later; doorman enrollment gap
  keeps the edge LAN-only for now — as-built blocker #2).
- JSON bodies; `schema_version` on every envelope. Errors everywhere use the backchannel-rpc
  error object: `{code (snake_case), message, retryable}`.
- Idempotency: every mutating request carries client-minted `id` (UUID); receivers de-duplicate
  on it; re-sends after network failure are safe (same rule as backchannel-rpc).
- Every response carries `freshness` where data is served: `{source, observed_at, window_s}`.

### 1.2 Authentication + principal

| Caller | Mechanism | Lineage |
| ------ | --------- | ------- |
| Human (browser) | Authentik SSO via Traefik forwardAuth; console-api verifies the header-trust nonce and strips spoofed inbound headers (assist pattern), reads `X-authentik-{username,groups,email}` | lab IAM, auth.petalcat.dev |
| Agent / service | `Authorization: Bearer <token>`; tokens minted/rotated by the control-plane TokenAuthority lineage (sha256 at rest, scoped, expiring, revocable) | control-plane `tokens.rs` + tracker `agent_tokens` |
| System (internal emitters) | Same bearer path with `system:` subjects | spool trust boundary today |

Every authenticated request resolves to a server-stamped **Principal**
(`schemas/principal.schema.json`):

```
{ schema_version: 1,
  kind: "human" | "agent" | "system",
  id: "parker" | "agent:janet" | "system:control-plane",
  tiers: ["owner"],            // permission levels, §7.3 — from Authentik groups / token scope
  lanes: ["operator","term_admin"],  // capability lanes for the command plane
  scopes: ["user:parker","fleet", ...] }  // resolved readable scopes (cacheable, zookie-fenced)
```

`sender_class` for dispatcher interop derives from `kind` (`human→principal` when tier=owner
or moderator, else `agent`/`system`) — same never-trust-the-sender rule the dispatcher already
enforces.

## 2. The statistic contract (the L1 canonical shape)

**One emission shape serves both doctrines**: a *signal* (bus semantics: what happened, look
here) and a *statistic* (lake semantics: a queryable, typed data point) are the same envelope.
Everything that happens in the lab serializes to this and calls `POST /emit` (or is bridged
onto it, §4.4). The semantic layer (L2) is auto-derived from these envelopes — the contract IS
the semantic layer's input.

`schemas/emission.schema.json`:

```
{ schema_version: 1,
  id: "uuid",                       // idempotency + dedup
  type: "doorman.link.flap",        // dot-namespaced event/statistic name; the semantic-layer key
  ts: "2026-07-12T19:20:11Z",       // when it happened (producer clock)
  source: { service: "doorman-edge", host: ".12", agent: null },
  subject: "janet@.202",            // what it is about (entity key; joinable)
  severity: "info",                 // debug|info|warn|danger|p0 — formalizes today's derived severity
  action: "watch doorman surface",  // optional: what a human/agent should do about it
  task_id: 4711,                    // optional tracker tie
  scope: "fleet",                   // ReBAC visibility tag (§7) — REQUIRED
  dimensions: { link_id: "b", role: "standby" },   // low-cardinality string facets
  measures:   { down_ms: 3200 },                   // numeric values
  meta: { unit: "ms", cardinality_hint: "low" }    // optional typing hints for L2
}
```

Rules:
- `type` is the registry key. **Auto-registration**: the first emission of a new `type` registers
  it (name, observed dimensions/measures, types, cardinality) in the semantic layer — no manual
  schema declaration (obs-graph research finding). Registry drift (a `type` changing shape) is
  surfaced as a curation proposal, not silently merged.
- `severity` is now a **first-class field** (the specs' derived-severity stopgap retires).
  Producers stamp it; the dispatcher's mapping (priority 0-3, interrupt_policy, governance
  light) is the bridging rule for as-built producers (§6.3).
- `scope` is required at emit time. Un-scoped emissions are rejected (fail-loud, not
  default-public). Bridges stamp scope by source rules.
- Every emission fans out to matching subscribers (most have none) AND lands in the lake
  (`events` hypertable) atomically from the caller's view: accepted = durable.
- High-frequency pure metrics (e.g. `host.cpu.pct` every 15s) use the same shape; the bus side
  simply has no subscribers at `severity: debug` and the lake rolls them into continuous
  aggregates. One door, no second ingest path.

## 3. Query plane

### 3.1 `stats.query` — `POST /api/v1/query`

Runs AS the caller (Rule 11). Two request modes (`schemas/query-request.schema.json`):

1. **Structured** (the default; what panels, surfaces, and the assistant compile to):
   `{ mode: "structured", from: "<type or view>", select: [...measures/dimensions/aggregations],
   where: {...}, group_by: [...], time: {from, to, bucket?}, order?, limit? }` — validated
   against the semantic layer (L2); rejects unknown fields with the catalog's nearest-match
   hint (feasibility honesty).
2. **SQL** (`mode: "sql"`, read-only): for agents and admin lanes. Executes under a read-only
   Postgres role AND the caller's scope filter (RLS). Keyword-blocked + statement-timeout
   (citeseer lineage: 20s hard timeout).

Response (`schemas/query-result.schema.json`): `{ columns: [{name, type}], rows: [[...]],
row_count, execution_ms, freshness, query_ref }`. `query_ref` is a durable id for the executed
query (provenance peek, PanelSpec indirection §9, re-run without recompile).

NL→query compilation is **not** this endpoint: the L3 engine (Phase 2) exposes
`POST /api/v1/ask` (compile → feasibility gate → PanelSpec/AnalyticalPlan → this endpoint).
Reserved here so the frontend can stub against it; contract detail lands with Phase 2 and is
additive.

### 3.2 The statistics catalog — `GET /api/v1/catalog`

The semantic layer, readable: every registered `type` with its dimensions, measures, types,
cardinality, last-emit ts, and scope — filtered to the caller (rows outside grant do not
arrive). This is the Observability catalog browse + the assistant's grounding corpus.

### 3.3 Typed entity reads — `GET /api/v1/<entity>`

Curated views the surfaces poll; all also reachable through `stats.query` (they are views over
the lake + sources of truth). Every response: `{schema_version, freshness, items: [...]}`.
Exact field lists are pinned in `schemas/entities/` and mirror the as-built shapes 1:1 unless
noted:

| Entity (GET)            | Serves | Source of truth | Shape notes |
| ----------------------- | ------ | --------------- | ----------- |
| `/fleet`                | roster rows, AgentChip everywhere | fleet events (bridged to bus; lake-persisted) | fleet-event v1 fields; `offline` stays consumer-derived; **aggregated across boxes** (closes the local-files-only gap) |
| `/heartbeats`           | status pills, architect cards, Terminal rows | manager heartbeat files (bridged) | heartbeat v2 incl. `channel_lock`; legacy `schema: 1` writers tolerated + normalized |
| `/registry`             | HouseTiles, routing eligibility | control-plane capacity SQLite | `handle, provides[], free_slots, host, last_seen_epoch`; liveness derived 90/300s |
| `/agents`               | identity + autonomy | tracker `agents` table | `handle, display_name, host, role, lane, capabilities, autonomy, active` |
| `/tasks`                | Work board, Cockpit | tracker tasks.db (single writer stays the tasks app) | full tracker row minus lease secrets |
| `/leases`               | countdowns, in-flight | tracker | **`leasePublic` only** (`task_id, worker, fence, granted_at, lease_expires_at, lease_seconds`) |
| `/cards`                | Soul Squad board, dead-letters, Signals drawer | dispatcher SQLite | full card row; `claim_token`-free by construction |
| `/box-updates`          | Updates surface, roof ticks | box_update_status (collector) | as-built row + 2nd-pass `packages[]`/`vulns[]` behind `raw_ref` expansion |
| `/workers`              | HouseTile windows, ProgressStream | `fleet/<handle>.subagents.json` (bridged) → box-agent inventory (Phase 1) | `{handle, label, started_at, updated_at, last_tool, tokens_spent?}` |
| `/governance`           | BudgetLight, fleet strip | control-plane (state persisted in Phase 1 — today in-memory) | `Light, Usage, BudgetGrant, Tier, FleetMode` per agent + pool |
| `/attention`            | Cockpit board, HUD chips | **attention store (new, §5)** | `schemas/attention-item.schema.json` |
| `/subscriptions`        | Signals · Delivery menu | **subscription store (new, §4.2)** | `schemas/subscription.schema.json` |
| `/delivery`             | Mindy Line | delivery config + receipts (new) | per-user `{channel, target, verified, updated_at}` + receipt reads via query plane |
| `/edge/registry`, `/edge/sessions` | Network surface | doorman (Phase 1 formalization) | shapes per Network spec; doorman work coordinates with `PetalNet/doorman` |
| `/dashboards`           | saved dashboards, home | Library items (`kind: artifact`, dashboard payload) | list projection; content via Library plane |

History reads (comms log, audit trails, incident timelines, the Void, delivery log, restart
counts) are **not** separate endpoints: they are `stats.query` reads over persisted emissions
(Rule 8 closes them by construction).

## 4. Bus plane

### 4.1 Subscribe — `WS /api/v1/bus/ws`

```
→ { schema_version: 1, action: "subscribe", sub_id: "s1",
    pattern: "doorman.*",                  // glob on type
    filter?: { severity_gte?: "warn", source?: {...}, subject?: "..." },
    since?: 184223 }                       // lake seq for gap-free resume
← { kind: "event", sub_id: "s1", seq: 184224, emission: {...} }   // scope-filtered server-side
← { kind: "heartbeat", ts, seq_head }                              // every 15s; THE bus-liveness
                                                                   // evidence for "everything is fine"
```

- Subscriptions are scoped: the server intersects the pattern with the caller's readable
  scopes. A pattern matching nothing you can see streams nothing, honestly.
- `since` replays from the lake (bus and lake share the seq), so reconnects are gap-free and
  a renderer can join live mid-stream with history from the same substrate.
- Multiple `sub_id`s per socket; `unsubscribe` by id.

### 4.2 Standing subscriptions + escalation (the delivery half)

Standing (persisted) subscriptions drive Signals digests + off-console delivery
(`schemas/subscription.schema.json`): `{pattern, filter?, tier: feed|digest|interrupt, loud:
bool, note, owner, updated_by, updated_at}`. Tier semantics per /task/709: interrupt reserved
for `severity: p0` | safety | principal-command; digests batch per window; feed is pull-only.
Delivery: Matrix by default (/task/713) via `delivery.*` ops; every delivery lands a
`delivery.receipt` emission. Config is agent-malleable: `subscription.set/remove` are ordinary
ops; the UI menu and an agent edit the same store.

### 4.3 Emit — `POST /api/v1/emit`

Body = emission (§2), auth = bearer. Accepted (`202 {seq}`) means durable-in-lake + fanned out.
Batch: `POST /emit/batch` (array, per-item results). Producers that cannot speak HTTP yet are
bridged (§4.4).

### 4.4 Bridging as-built producers (fleet-bus aggregation)

Until every producer emits natively, a **bridge** (part of console-api's substrate, Phase 1)
tails the as-built shapes and emits on their behalf, stamping `scope` and `severity` by source
rules. No as-built writer changes to get on the bus:

| As-built source | Bridged emission types |
| --------------- | ---------------------- |
| `data/fleet/<handle>.json` (per box, incl. remote boxes via a per-box tail) | `fleet.event.*` — closes the cockpit's same-box-only gap |
| manager heartbeat files | `agent.heartbeat`, `agent.crashed`, `channel.lockout` |
| dispatcher card lifecycle (SQLite triggers → outbox) | `card.posted/parked/claimed/done/dead`, comms events |
| control-plane spool events | `governance.action`, `fleet.mode`, `discipline.nag`, `usage.report` |
| `~/.claude/shared/system-outbox/` (shawn/derek/michael bot warnings) | `host.disk.pct`, `container.update_available`, `box.update_status_changed`, … — **the bot-spam retirement path** (/task/681 driving use case) |
| tasks tracker events table | `task.created/claimed/transitioned/closed`, `artifact.created` |

Severity bridging rule for dispatcher shapes: `priority 0 → p0, 1 → danger, 2 → warn, 3 → info`;
`interrupt_policy: safety → p0`; governance `red → danger, yellow → warn`. New native emitters
(crack sources: service-down probes, box-OOM, doorman-dark, ingest-lag, library.index.degraded)
are Phase 1/2 work items and emit natively from day one.

## 5. Command plane

### 5.1 The op envelope — `POST /api/v1/op`

`schemas/op-call.schema.json` / `op-result.schema.json`:

```
→ { schema_version: 1, id: "uuid",       // idempotency key
    op: "agent.restart",                  // namespaced, from the catalog
    args: { handle: "janet" },
    task_id?: 4711,
    reason?: "stuck on rate-limit loop" } // audited verbatim
← { schema_version: 1, in_reply_to: "uuid", ok: true,
    result: {...},                        // op-specific
    audit_seq: 184225,                    // the audit emission's lake seq (the receipt)
    executor: { kind: "manager", ref: "janet@.202", liveness: "alive" } }
| ← { ok: false, error: { code: "executor_unreachable", message, retryable: true },
      executor: {...} }
```

Semantics (Rules 7, 9, 10 + Foundations §2.3):
- **Availability = lane ∩ executor-liveness.** Every op declares its executor; the API checks
  the executor's liveness (registry/heartbeat), never the target's data freshness. Disabled ops
  return `executor_unreachable` (retryable) — the UI's disabled-with-reason. Unauthorized lanes
  get `unauthorized` (not retryable) — and for Terminal, an audited denial.
- **Audit before effect**: the audit emission (`audit.op` type: op, args-hash, principal,
  outcome) commits to the lake before the effect is acknowledged; if the audit write fails the
  op does not run (Terminal's ordering rule, generalized).
- **Undo**: ops that support it return `undo: {op, args}`.

### 5.2 The op catalog

Machine-readable: [`ops.json`](ops.json) — one entry per op: `{op, args (typed), lane,
executor, effect, emits, availability, lineage}`. The catalog is the contract the frontend
renders ActionRows from; a UI button without a catalog entry is a defect (Rule 9). Summary by
namespace (66 ops):

| Namespace | Ops | Executor | Lane |
| --------- | --- | -------- | ---- |
| `attention.*` | ack, snooze, resolve | console-api (attention store) | viewer(own scope) |
| `task.*` | get_ready, up_next, claim, update, close, dispatch | tasks tracker (canonical helpers) / dispatcher (dispatch) | operator |
| `agent.*` | start, stop, restart, kill_session, autonomy | the agent's manager | operator; kill_session=admin |
| `governance.*` | action(pause\|throttle\|downgrade\|restore), tier, pause | control-plane | operator |
| `fleet.*` | mode(parallel\|sequential) | control-plane | operator |
| `channel.*` | reclaim | the agent's manager | admin (**new op** — closes the lockout-has-no-release gap) |
| `signal.*` | snooze(scope, duration) | console-api (bus) | viewer(own scope) |
| `subscription.*` | set, remove | console-api (subscription store) | viewer(own) / operator(others) |
| `card.*` | repost, park | dispatcher | operator |
| `dashboard.*` | save, load, set_home, pin | Library (items) | viewer(own scope) |
| `library.*` | item.create, item.update, link.add, hold | librarian/library service | operator (scope-checked) |
| `kb.*` / `research` | search, research | library service (sole egress) | viewer |
| `curation.*` | propose, approve, reject | librarian; approvals human-gated | operator / owner |
| `item.*` | weed, merge, delete | library service | operator; delete=owner+typed-name |
| `promotion.*` | request, approve | library service | viewer / owner |
| `service.*` | restart, stop, logs | box-agent on the host | operator; stop=confirm |
| `host.*` | probe, reboot | probe runner / box-agent | operator; reboot=admin |
| `updates.*` | approve, apply, check | box-agent (agent-mode boxes only) | operator |
| `edge.*` | enroll.approve, enroll.deny, key.revoke | doorman edge + control-plane TokenAuthority | admin |
| `doorman.*` | session.drop, redial | edge daemon / agent's manager | admin |
| `term.*` | watch, attach, input, resize, scrollback, detach | PTY streamer (tmux pipe-pane lineage) | **TERM_ADMIN humans only — agents structurally excluded** |
| `delivery.*` | test, set_target, cocoon | console-api → Matrix | viewer(own line) |
| `stats.*` / `viz.*` / `text.*` / `window.*` / `context.*` | query, render, surface, arrange, receive | engine / shell (tool surface §9) | viewer |

Command routing reality (Phase 1 scope): manager ops need a **new command inlet** — the manager
today only reads Matrix `!commands`. Phase 1 adds a backchannel-rpc command spool/RPC inlet to
the manager (`method: agent.command`), keeping Matrix as the never-dark fallback floor; the
dispatcher/control-plane ops ride their existing envelope methods; tracker ops call the tasks
app's canonical helpers over its HTTP RPC (never raw SQL — single-writer rule).

### 5.3 The attention store

One attention state for the whole lab (channel-agnostic resolution, /task/685 + /task/695).
`schemas/attention-item.schema.json`:

```
{ schema_version: 1, id, grade: "p0"|"blocker"|"review"|"artifact",
  source: "heartbeat"|"bus:<type>"|"tracker"|..., subject, summary, ts,
  scope, task_id?, incident_key?,        // source+subject+window collapse
  acked_by?, snoozed_until?, resolved_by?, resolved_via? ("ui"|"agent"|"auto") }
```

Items are created by attention rules over emissions (crashed heartbeat, P0 signal,
review-ready transition, requested-artifact completion, delivery failure), mutate ONLY via
`attention.ack/snooze/resolve` (any channel), and every mutation emits — so the cockpit, an
agent in chat, and Matrix all see one truth. Incident collapse + flap damping live here
(incident_key), not in renderers.

## 6. Library plane (Rev3, the one store)

The Library IS the store (/task/718); Work, gallery, docs, dashboards are lenses. The console
API exposes the Rev3 surface; the full librarian build (CRDT prose, curation autonomy) is its
own effort — **this contract pins the wire surface** so lenses and the assistant bind now:

- `GET/POST /api/v1/library/items` + `GET /items/:id` — polymorphic item
  `{id, entity_id, kind (closed enum + governed extension e.g. `map`), title, status
  (MV-Register), body_ref, render_mode, confidence, source_url, properties, version, tx_from}`;
  revisions retained.
- `POST /api/v1/library/links` — grow-only typed links `{from_id, to_id, rel_type:
  belongs-to|supersedes|derived-from|duplicate-of|references, reason}`.
- `POST /api/v1/library/search` — hybrid BM25 + dense (pgvector) + RRF fusion, scope-filtered
  below the ranker; returns why-matched.
- Provenance facets on every item: `created_by_agent, responsible_human, handed_off_to`.
- Holds, curation proposals, promotion: via `library.*`/`curation.*`/`promotion.*` ops (§5.2).
- **Convergence is phased**: tasks stay tracker-owned (single writer) and are *projected* as
  items read-only in Phase 1; artifacts/feed/docs converge into the store as the librarian
  lands. The lens contract is stable across that migration — consumers never see the seam.

## 7. ReBAC scope + permission levels (the primitive)

### 7.1 Scope tags

Every emission, item, task, and subscription carries `scope` (string, one of):
`user:<id>` · `agent:<handle>` · `project:<id>` · `fleet` · `restricted:<name>`.
Personal data (health, location) is `user:*`; lab-wide telemetry is `fleet`;
`restricted:*` requires an explicit grant even for moderators.

### 7.2 Grants (ReBAC tuples)

`schemas/scope-grant.schema.json`: `{subject (principal or tier), relation:
viewer|editor|operator|owner, object (scope | item ref | op namespace), condition?,
valid_at, invalid_at?, granted_by, zookie}` — lean tracker-native scheme (per /task/724
research: hybrid Authentik-groups-coarse + per-resource tuples; OpenFGA/SpiceDB explicitly
not adopted at this scale). Checks are zookie-fenced (no stale-grant reads after revoke).
Enforcement: scope-filter injection in the query layer + Postgres RLS backstop on lake and
library tables + lane checks in the op router. Three layers, one truth.

### 7.3 Permission levels (extensible tiers — build the primitive, configure later)

A **tier** is a named, DB-defined bundle: `{name, authentik_group, default_relations
[(relation, object-pattern)], propose_only: bool}`. Seed rows: `owner` (parker), `moderator`
(eli), `collaborator` (propose-not-commit: file ideas via tracker suggestion queue, read
explicitly-shared only, no live-system ops), `guest`. Tiers are rows, not enums — adding a
level is an insert + grants, no schema change (/task/723/724). `propose_only` callers get
`*.propose` variants of mutating ops routed into the tracker suggestion queue; owners promote.

## 8. Freshness windows (normative)

heartbeat ≤30s · fleet snapshot ≤90s (then offline) · registry ≤90s suspect / ≤300s down ·
Matrix sync ≤120s · resource series ≤60s · box_update ≤2× check cadence · bus WS heartbeat 15s,
silent ≥90s = "Can't verify" · link heartbeat ≤30s, unknown >90s. Every read's `freshness`
carries `observed_at`; the consumer computes. "Everything is fine" requires fresh bus heartbeat
AND fresh fleet snapshot (positive evidence).

## 9. Render contract + dashboard-assistant tool surface

The six shell tools (/task/703, Foundations §5.2) bind to the planes 1:1 — the assistant holds
no private APIs (an agent with the same grants composes the same window):

| Tool | Binding |
| ---- | ------- |
| `stats.query` | Query plane §3.1 (as the asking user) |
| `viz.render` | **PanelSpec v2** (`schemas/panel-spec-v2.schema.json`): citeseer PanelSpec (type, title, encoding, forecast, confidence) + `query_ref` indirection (replaces inlined SQL; the peek resolves the ref) |
| `text.surface` | prose + **stat bindings**: `{{stat:<query_ref>#<column>[agg]}}` spans → live, proved, drillable inline numbers; unbound numbers render visibly unproven |
| `window.arrange` | layout ops `{place, size, group, highlight, clear, pin}` on a 12-col grid model — state, not pixels; renderer-agnostic |
| `dashboard.save/load/set_home/pin` | Library items (`kind: artifact`, payload = `{layout, panels: PanelSpecV2[], query_refs}`); investigations = item trees via `parentDashboardId` lineage (ExplorationGraph) |
| `context.receive` | right-click payload `{element_kind, value, query_ref?, entity_ref?}` injected as the most recent chat message |

The per-user assistant session itself (custom claude-code manager, /task/707) is Phase 5; this
contract fixes its tool surface now so the frontend's shell and the runtime meet at a stable
seam.

## 10. Observability of the surface itself

console-api instruments per Rule 8: every request/op/emit/WS event is itself an emission
(`console.api.*`), Glitchtip on the service (inert-without-DSN convention), and the feasibility
gate refuses honestly — "not instrumented" is a correct answer, never a hallucinated shape.

## 11. Out of scope for P0 (lands in the named phase)

- Engine endpoints `POST /ask`, self-heal internals, forecasting (Phase 2 — contract additive).
- Doorman session/edge shapes beyond §3.3's read views (Phase 1, coordinated with `PetalNet/doorman`).
- PTY stream framing (`term.*` transport spec; Phase 1 command-plane work, Terminal spec owns
  the frame shape and the audit-before-first-frame rule which §5.1 already generalizes).
- Full librarian curation autonomy (library service build; the wire surface above is stable).
- The per-user claude-code manager runtime (Phase 5; tool seam pinned in §9).

## 12. Migration notes

v0 consumers (cockpit fleet.js reading local files, Matrix !commands) keep working throughout:
bridges emit on their behalf (§4.4; `lineage` fields in ops.json), Matrix remains the
never-dark floor, and no as-built writer changes shape until its consumer is on the plane.
