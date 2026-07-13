# Lab Console — Contract Surface (P0, board round 1 applied)

\_Branch `feat/console-p0-contracts` · console-backend Fable, 2026-07-12 · REVIEWABLE SPEC ONLY —
no service code in this node. This is the contract the console FRONTEND builds against and the
work list the console-backend phases implement. Machine-readable schemas: [`schemas/`](schemas/)

- [`schemas/entities/`](schemas/entities/) (JSON Schema draft 2020-12; CI validates examples
  with ajv **format assertion ON** — `format` is enforced, not annotation). Board round 1
  (5 personas + codex) findings and resolutions: [DECISIONS-P0.md](../DECISIONS-P0.md).
  Grounded in: the console specs (`console-fable/specs/src/`, esp. `00-foundations` §6),
  WAYFINDER-DECISIONS.md, SYSTEM-MAP-as-built.md, the N0.1 contracts, GRAPHING-BACKEND-BRIEF.md.\_

The console binds to **four planes**. Where the UI specs and this document disagree, the specs'
_requirements_ win and this document has a bug; where this document and an implementation
disagree, this document wins and the implementation has a bug. UI-spec op-name drift is resolved
in `ops.json.spec_name_aliases` (the catalog name is the wire name).

## 0. Rules (inherited from N0.1, extended)

1. **Versioned.** Every instance carries `schema_version` (integer, `const`-pinned). Additive
   optional fields = same version **where `additionalProperties` allows** (the N0.1 qualifier):
   all server→client shapes are `additionalProperties: true` and consumers MUST ignore unknown
   fields; client→server shapes are strict — with one named exemption: the emission envelope
   is dual-role (client-written, server-served) and stays `additionalProperties: true`.
   Rename/remove/retype/enum-meaning change = bump + migration note here.
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
   logs and self-emissions. Lease projections are `leasePublic` only — including the
   `task.claimed` emission; the one deliberate exception is `task.claim`'s result to AGENT
   callers (authenticated channel), whose dedup-recorded copy is stored SCRUBBED (idempotent
   replay returns leasePublic) and whose result body joins `term.input` on the
   never-capture list for self-instrumentation.
7. **Caller identity is server-stamped.** Nothing trusts a client-asserted principal, scope,
   `sender_class`, capability lane, or **emission source** (§4.3). The API authenticates, then
   stamps. `Principal.kind` binds at the auth path (Authentik header ⇒ human; bearer mint
   record ⇒ agent/system), never inferred from an id string. The principal is carried as a
   verifiable assertion across every executor hop (tracker RPC, manager inlet) — an executor
   never accepts "who this is for" as a plain argument.
8. **Everything emits, everything lands** (/task/710). Every occurrence emits a typed event
   unconditionally AND persists as a queryable statistic. Bus = signals; lake = data.
   Anti-recursion: `console.api.*` self-instrumentation is exempt from self-instrumentation,
   WS _deliveries_ are not individually instrumented (per-subscriber counters aggregate), and
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

| Plane   | Contract                                                                  | Transport                                                                                                | Today's shape it formalizes                                                                                         |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Query   | `stats.query` as-user + typed entity reads, freshness metadata            | HTTPS JSON (`POST /api/v1/query`, `GET /api/v1/<entity>`)                                                | tasks.db rows, heartbeat.json, `data/fleet/*.json`, dispatcher SQLite, capacity SQLite, box_update rows, term_audit |
| Command | Named ops, 1:1 with UI actions, lane+target authorized, two-phase audited | HTTPS JSON (`POST /api/v1/op`)                                                                           | Matrix `!commands`, spool envelopes, governance actions, token mint/rotate, tracker mutations                       |
| Bus     | Scoped subscribe over typed signals; authorized unconditional emit        | WebSocket (`/api/v1/bus/ws`, frames: `schemas/bus-frame.schema.json`) + HTTPS emit (`POST /api/v1/emit`) | fleet-event stream, backchannel-rpc events, dispatcher card lifecycle, the Matrix bot-spam this retires             |
| Library | Rev3 item + link API: hybrid search, typed links, provenance, curation    | HTTPS JSON (`/api/v1/library/*`)                                                                         | tasks / artifacts / feed_items / projects converging into the one store                                             |

One service owns the surface: **`console-api`** (`apps/console-api`) — a gateway + substrate,
not a re-implementation: commands route to their real executors, reads serve from the lake and
the sources of truth. Blast radius, stated plainly: console-api down ⇒ every console surface is
honestly dark and Matrix remains the command floor; the assistant is never a dependency of the
emergency path, and neither is this service pretending otherwise.

### 1.1 Base protocol

- Base URL `https://console-api.petalcat.dev/api/v1` (LAN-only until the doorman enrollment
  gate lands).
- JSON; errors everywhere are `{code (snake_case), message, retryable}` (backchannel-rpc).
- `schema_version` rides every contracted JSON _body_ (op envelopes, emissions, WS frames,
  read envelopes). Bare transport acknowledgements (`202 {seq}`, health) are pinned by their
  own schemas instead of carrying versions.
- Idempotency: every mutating request carries client-minted `id` (UUID). Duplicate
  `(principal, id)` within the dedup window (≥24h, ≥ the max retry horizon) returns the
  recorded result; the same id with a different body is rejected (`id_reused`).
- List reads paginate: `limit` (default 200, max 1000), `cursor`, `since`, per-entity filters;
  responses are the `read-envelope` shape (`schemas/entities/read-envelope.schema.json`) with
  `next_cursor`. Responses carry a server byte cap; `truncated: true` when clipped — silent
  truncation is banned.
- `GET /api/v1/health` (`schemas/health.schema.json`) — systemd watchdog + Traefik gate +
  the Mindy Line's line-health source. Emit acks are `schemas/emit-ack.schema.json`.
  `GET /api/v1/me` → the caller's Principal + display/grant name.

### 1.2 Authentication + principal

| Caller                     | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human (browser)            | Authentik SSO via a **dedicated** console-api forwardAuth middleware: per-boot nonce, strip-set == authResponseHeaders, full assist-`auth.py` parity (reject extra/duplicate/underscore-folded/control-char `x-authentik-*` headers, canonicalize names). **Hard precondition:** the shared `:80` entrypoint's `forwardedHeaders.trustedIPs` gap is closed before console-api serves a single authenticated route — this surface carries `host.reboot` and `term.*`, not browser automation. |
| Agent / service            | `Authorization: Bearer <token>`. Vault keeps plaintext for re-issue (as-built CP4); console-api's _verification_ table stores sha256 only. Revocation is checked **per request**, independent of the grant zookie; rotation grace is bounded and dual-validity audited.                                                                                                                                                                                                                      |
| System (bridges, internal) | Same bearer path, `system:` subjects, distinct trusted producer registrations (§4.3).                                                                                                                                                                                                                                                                                                                                                                                                        |

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
  red→danger, yellow→warn) affects severity display only — interrupt _eligibility_ remains the
  dispatcher's LOCKED `interrupt_policy` domain.
- **Accepted = durable + fanned out**; high-frequency metrics use the same shape and door.

**L1 implementation (2026-07-13):** `events` and `event_archive` are TimescaleDB hypertables.
Global UUID idempotency is decided transactionally in the plain `emission_ids` gate before the
hypertable insert, preserving the serialized appender's commit-order `seq`. `audit.*`, `term.*`,
`edge.*`, `security.*`, and emissions stamped `meta.retention_class: "audit"` are copied to the
long-retention archive in the same transaction. Normal structured reads use the RLS-protected
`lake_events` union, so expiry from the 30-day raw table does not erase contractual history.
`event_rollup_1m` is the real Timescale continuous aggregate (60-second refresh; 370-day retention).
Raw expiry runs through an ordered refresh-before-drop job, so recovery after scheduler/database downtime
materializes every still-raw bucket before enforcing the 30-day boundary.

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
never needs the LLM). **Dereferencing a `query_ref` (peek, re-run, stat-binding refresh)
always executes as the DEREFERENCING caller** — a shared panel refuses per-viewer, never
replays the author's scopes. NL→query is `POST /api/v1/ask` (Phase 2, additive).

**Shipped L2 query refs (2026-07-13):** every successful structured execution persists its
request, placeholder SQL, columns, timing, and authorizing scope set under the returned ref.
`GET /api/v1/query/:query_ref` peeks that provenance and
`POST /api/v1/query/:query_ref/rerun` executes the stored structured request through the current
caller's RLS scopes (and returns a new ref). Because the record contains filter values and may span
several grants, peek/rerun requires the caller to hold the **complete originating scope set** (a
strict superset is allowed); otherwise it is indistinguishable from a missing ref (404). The
originating grants are never replayed implicitly. Structured `sum` requires counter/delta semantics,
and `avg` over a counter is rejected as `agg_mismatch`. Registered all-event/relationship views
expose only their declared pseudo-fields; dynamic type fields require querying that statistic type.
The request schema reserves `rate`, `fill: zero|previous`, and `coverage`, but this build refuses
those honestly (`bad_agg`/`unsupported_fill`/`unsupported_coverage`) rather than fabricating data.

### 3.1a Services availability — `GET /api/v1/availability`

The Hosts uptime-kuma replacement is a typed, caller-scoped derivation over the lake, pinned by
`schemas/availability.schema.json`. `service.probe` is the canonical statistic: `subject` identifies
the watched service (prefer `<host>/<service>`), `dimensions.ok` is the observed boolean result,
`measures.latency_ms` is the response latency, and optional `measures.cadence_s` and
`measures.degraded_threshold_ms` override the 30-second / 500-ms defaults. `service.down` and
`service.up` are the matching bus facts. The endpoint accepts `window=24h|7d|30d` (default `30d`).

`down` means the latest service signal is down, the last three probes failed, or three expected
cadences elapsed without a probe. `degraded` means the observed p95 exceeds the service threshold;
otherwise the service is `up`. Uptime is successful / observed probes, never successful / expected.
Coverage is observed / expected over the printed window, and the largest missing interval is returned
so a gap cannot masquerade as a clean percentage. Each row includes p50 and at most the latest 60
probe points for the inline sparkline. The scoped availability projection retains each service's
latest probe and latest up/down signal beyond raw-lake retention; the reporting window limits only
the statistics, never service identity or current-down derivation. Malformed probe results increment
`invalid_probes` and set `source_error` instead of disappearing from coverage. The read executes with
the caller's RLS scopes.

### 3.1b Cost pairwise comparison — `POST /api/v1/cost/compare`

Runs as the caller over `usage_events` and `model_pricing`; request and response are
`schemas/cost-comparison-request.schema.json` and `schemas/cost-comparison-result.schema.json`.
Those sources are the BR-033 AgentsView mirror views required by the Cost dashboard. Until they are
registered, callers with the fleet-wide grant fall through to AgentsView's deployed pairwise API;
narrower callers fail closed rather than reading the meter's unscoped global store. The local
adapter defaults to `http://127.0.0.1:8098/api/v1` with its deployed `localhost:8080` Host allowlist;
`CONSOLE_COST_METER_URL`, `CONSOLE_COST_METER_HOST`, and optional
`CONSOLE_COST_METER_TOKEN` override that seam atomically. `usage_events` must expose `cost_status`
and `cost_source` so reported and computed partitions aggregate separately. Any truncated source
read fails as `comparison_incomplete` rather than returning a partial delta. The deployed fallback
accepts only local-midnight ledger windows because its exhaustive aggregate API has calendar-day
granularity; it never widens an arbitrary timestamp interval.
The two values must be distinct members of one supported dimension (`agent`, `model`, or `project`)
and share one requested time window. The API returns both sides plus right-minus-left deltas and
right/left ratios for total cost, tokens, sessions, cost per session, tokens per session, and each
token kind. A ratio is `null` when the left baseline is zero. Cost follows the ledger law per row:
reported cost wins when present; otherwise the four token kinds are priced against the live price
book. Both source references are returned with receipt metadata: literal query, cost source,
rows/timing/freshness, matched model rates, price-table version, and digest.

### 3.1.1 Dashboard compiler — `POST /api/v1/ask`

L3 is live (2026-07-13). The strict request is `schemas/ask-request.schema.json`; the response is
`schemas/ask-result.schema.json`. The engine retrieves only the caller's semantic corpus, then asks
the configured OpenAI-compatible compiler for a **structured query intent**, never SQL. The server
validates sources, fields, aggregation semantics, and explicitly stated filter values; compiles SQL
itself; dry-plans and executes it as the distinct `console_ro` role; and persists the result through
the existing query-ref provenance path. `console_ro` is `NOSUPERUSER NOBYPASSRLS`, has only SELECT
grants, and defaults every transaction to read-only. Its statement timeout is 20s (5s for EXPLAIN).

Execution-guided repair is bounded to two total compiler attempts. Feedback contains a typed safe
validation code/message, never raw database detail, retrieved private values, or arbitrary SQL. No
scopes or no matching caller-visible semantics produces an explicit refusal without execution.
Successful answers contain grounded plain prose, top-level follow-up `suggestions`, PanelSpec v2
with `query_ref`, the query result, retrieval refs, and `shown_sql` (server-compiled placeholder SQL
and caller-visible params). Refusals return HTTP 200 with `status: "refused"`, a refusal panel, and
null result/SQL. Missing compiler configuration (`CONSOLE_ASSISTANT_LLM_URL` +
`CONSOLE_ASSISTANT_LLM_MODEL`, optional API key) is a
retryable 503; malformed questions are 400. Existing GlitchTip/Sentry exception capture covers this
route without request bodies, prompts, model responses, or bearer data.

### 3.1.2 Render + investigation replay — L4

L4 is live (2026-07-13). Successful `/ask` panels include a `render` artifact. The server selects
the safe default chart from column semantics and observed cardinality: one numeric measure → stat,
time × measure → line, categorical dimension × measure with at most 20 values → bar, two measures
→ scatter, otherwise table. The selection reason is carried with the artifact; renderers do not
reimplement this policy. Chart artifacts are Vega-Lite v6 JSON with inline data. Stat/table/text and
refusal panels use `renderer: "native"` and a null Vega spec.

Line panels may carry a bounded `forecast` block. The backend implements deterministic linear,
drift, moving-average, exponential-smoothing, and seasonal-naive strategies. `auto` chooses only
from those methods; forecast points and confidence bands are explicit data in the Vega-Lite spec,
and `forecast_strategy` records the actual method used. Forecasting falls back to the ordinary
historical line when there are fewer than three numeric points or the x axis is neither temporal nor
numeric; it never invents a model result. Points are normalized into ascending x order before
fitting, numeric x axes remain Vega-Lite `quantitative`, and bucketed structured queries default to
`bucket asc` when the caller supplies no order.

`POST /api/v1/render` (`schemas/render-request.schema.json`) resolves the supplied `query_ref` under
the caller's RLS scopes, re-runs the stored structured request as that caller, and returns
`schemas/materialized-panel.schema.json`. A missing or invisible ref is the same 404. The stored
query, not client SQL or cached rows, is the replay source.

Dashboards and investigation nodes are durable scoped Library data:

- `POST /api/v1/dashboards` accepts `schemas/dashboard-save.schema.json`, including
  `schema_version: 1` and a client-minted mutation UUID. Retries by principal + UUID return the same
  item; body drift is `id_reused`. Every source query ref must already be visible to the caller, and
  the target scope must be one of the caller's current scopes. Before commit, every data panel and
  text stat binding is re-run under **only** that target scope and rebound to the target-scoped ref.
  A query that cannot execute there makes the save `query_not_shareable`. Vega artifacts and
  result-derived narration are cleared, and raw SelectedMark `datum`/`value` are stripped before
  persistence. Panel intent, rebound refs, layout, time range, and safe branch lineage remain data.
- `GET /api/v1/dashboards` returns the normal read envelope of visible list projections. Investigation
  rows expose `is_investigation`, `parent_id`, and `parent_question`, so clients can lay out the
  GraphNode tree without fetching or leaking saved panel payloads. `limit` is
  1–1000 and `next_cursor` is an authenticated opaque `(updated_at,id)` continuation retaining the
  database's full timestamp precision; forged or invalid cursors are 400. Production requires
  `CONSOLE_API_CURSOR_SECRET`; rotating it intentionally invalidates outstanding cursors.
- `GET /api/v1/dashboards/{id}` returns `schemas/dashboard-detail.schema.json`: the saved payload
  plus `materialized_panels`. Every data panel re-runs as the viewer and gets a fresh query
  ref/render artifact; a now-invisible panel is an explicit per-panel refusal. The item itself is 404
  when its scope is not visible. Text `{{stat:query_ref#column[agg]}}` bindings are likewise re-run;
  `render.bindings[]` carries each fresh ref/value or an explicit `refused` status.
- `POST /api/v1/dashboards/{id}/home` accepts a mutation UUID and exposes the canonical
  `dashboard.set_home` operation for first-party Remote Functions. It remains owner-only and follows
  propose-not-commit policy before changing the caller's pinned home artifact.

The branch block is the investigation tree edge: `parent_dashboard_id`, `parent_question`, filters,
SelectedMark-complete context, and assumptions. Sharing is scope/ReBAC sharing, never copied query
results; Phase 3 extends the subject-specific grant path without changing these L4 shapes.
`POST /api/v1/investigations/branches` resolves the parent query ref as the caller, injects the
SelectedMark field/value into the stored structured query, executes it, and saves the child with the
filtered query ref plus safe filter intent. A child can therefore never masquerade an unfiltered parent
result as drill-through evidence.

### 3.2 The statistics catalog — `GET /api/v1/catalog`

The semantic layer, readable, scope-filtered: `schemas/entities/catalog-entry.schema.json`
(type, per-field dimension/measure typing, cardinality, last_emit, emit rate, observed scopes).

L2 is live: `GET /api/v1/catalog` returns the shared read envelope (`freshness`, `items`, always-
present opaque `next_cursor`, and `truncated`) with a 1 MiB server cap. Byte clipping resumes at the
first omitted type; if one entry alone exceeds the cap, the response explicitly lists it in
`omitted_types` and advances, so pagination always makes progress without silently losing a row.
Field descriptors and relationship joins derive transactionally from accepted
emissions; bounded hashed-value sampling classifies dimension cardinality without storing raw
dimension values. Every caller-visible registry projection, cardinality set, and statistic search
document is keyed to one exact scope; the cross-scope aggregate is writer-only coordination state.
Consequently, overlapping access can never reveal field names, joins, or cardinality learned in a
different scope. Conflicting dimension types or measure kind/unit declarations do not silently
rewrite established semantics: the event remains durable and a scoped `registry_drift` curation
proposal is created. Producer registrations carry configurable `max_emit_per_min` (default 6000)
and `max_new_types_per_hour` (default 20); over-cap new types are metadata-only quarantined and
proposed for curation, while same-id retries return the durable rejection without consuming rate
budget until its stored eligibility time; the same body can then be admitted in the new window.
Single-emission cap responses are HTTP 429 with `Retry-After`, `retryable: true`, and
`retry_after_s`; batch item errors carry `retryable: true`.

`GET /api/v1/catalog/search?q=<text>&limit=<1..32>` returns the scope-filtered hybrid retrieval
slice (`schemas/semantic-search-result.schema.json`) over a normalized 75% pgvector cosine / 25%
PostgreSQL full-text score. The corpus contains catalog definitions, registered views, and successful query
structures; query filter values never enter searchable text. Embeddings are currently the hermetic
384-dimension `feature-hash-v1` provider. Registered structured-query views are `events` (the
raw+archive lake) and `relationships` (statistics joined to materialized edges). Governed custom
views publish their direct dimension/measure descriptors in `semantic_views.fields`; validation and
aggregation use those descriptors, and undeclared columns are not addressable.

`GET /api/v1/palette/search?q=<text>&limit=<1..32>` is the shell's bounded, scope-filtered object
retrieval seam. It ranks visible agents, tasks, Library items, hosts, and semantic statistics into a
single deterministic result shape (`id`, `kind`, `label`, `description`, `href`, `meta`, `score`) in
a read envelope whose `freshness` records the palette assembly time.
Each source fails independently and is reported as `live|unavailable`; static surfaces and safe
navigation actions remain in the frontend because they carry no operational data or authorization.

### 3.3 Typed entity reads — `GET /api/v1/<entity>`

Every read returns the `read-envelope` (freshness + items + pagination). **Every entity item
shape is pinned in [`schemas/entities/`](schemas/entities/)** — the frontend never reads
another repo to learn a field. Aggregated reads carry per-item `observed_at` (Rule 10).

| Entity (GET)                       | Schema                                | Source of truth                                          | Notes                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/fleet`                           | `entities/fleet.schema.json`          | fleet events (bridged; lake-persisted)                   | aggregated across boxes; `offline` consumer-derived                                                                                                                                                   |
| `/heartbeats`                      | `entities/heartbeat.schema.json`      | manager heartbeat files (bridged)                        | rows ARE manager heartbeats (one per manager; architects view groups by host); legacy `schema: 1` normalized                                                                                          |
| `/registry`                        | `entities/registry.schema.json`       | control-plane capacity SQLite                            | liveness derived 90/300s                                                                                                                                                                              |
| `/agents`                          | `entities/agent.schema.json`          | tracker `agents` table                                   | identity converges to a Library item later; read stays stable                                                                                                                                         |
| `/tasks`                           | `entities/task.schema.json`           | tracker (single writer stays the tasks app)              | filters: status, project_id, assignee, since                                                                                                                                                          |
| `/leases`                          | `entities/lease.schema.json`          | tracker                                                  | `leasePublic` only                                                                                                                                                                                    |
| `/cards`                           | `entities/card.schema.json`           | dispatcher SQLite (read-only poll)                       | filters: state, recipient                                                                                                                                                                             |
| `/box-updates`                     | `entities/box-update.schema.json`     | box_update_status collector                              | `GET /box-updates/{box_id}/raw` → `box-update-raw` (packages[], vulns[])                                                                                                                              |
| `/workers`                         | `entities/worker.schema.json`         | subagents.json (bridged) → box-agent inventory (Phase 1) | carries `host` — HouseTile needs no join                                                                                                                                                              |
| `/governance`                      | `entities/governance.schema.json`     | control-plane (persisted in Phase 1)                     | per-agent + pool `$defs`                                                                                                                                                                              |
| `/attention`                       | `../attention-item.schema.json`       | attention store (§5.3)                                   | `fix_ops` args pre-bound server-side                                                                                                                                                                  |
| `/subscriptions`                   | `../subscription.schema.json`         | subscription store                                       | incl. digest `window`                                                                                                                                                                                 |
| `/delivery`                        | `entities/delivery.schema.json`       | delivery config                                          | incl. `cocoon_until`, `next_digest_at`; line health also reads `/health.matrix_sync_ok_epoch`                                                                                                         |
| `/edge/registry`, `/edge/sessions` | `entities/edge-*.schema.json`         | doorman (Phase 1 formalization)                          |                                                                                                                                                                                                       |
| `/dashboards`                      | `entities/dashboard-item.schema.json` | Library items                                            | incl. `is_home`; content via Library plane                                                                                                                                                            |
| `/executors`                       | `entities/executor.schema.json`       | registry + heartbeats + service probes                   | **pre-flight liveness for every ActionRow** — all ten executor kinds of the catalog (managers, dispatcher, control-plane, tracker, library, per-box box-agents, edge, probe-runner, pty, console-api) |
| `/roster`                          | `entities/roster.schema.json`         | server-side join                                         | the Agents surface in ONE read (fleet × heartbeat × registry × agents × governance × leases × workers)                                                                                                |
| `/me`                              | `entities/me.schema.json`             | auth                                                     | Principal + display/grant name (session chip)                                                                                                                                                         |
| `/grants?object=...`               | `../grant-list.schema.json`           | ReBAC tuples                                             | owner-only current grant enumeration; mutations use `POST /grants` + `grant-mutation.schema.json`                                                                                                     |
| `/tiers`                           | `schemas/tier-list.schema.json`       | permission-level rows                                    | authenticated catalog for user/share pickers; adding a level is a data insert                                                                                                                         |

History reads (comms log, audit trails, the Void, delivery log, restart counts) are
`stats.query` reads over persisted emissions. `audit.op` emissions pin `subject` = the target
entity, so per-target derivations (restart counts per handle) are one `group_by`.

## 4. Bus plane

### 4.1 Subscribe — `WS /api/v1/bus/ws` (frames: `schemas/bus-frame.schema.json`, normative)

Protocol summary (details in the schema): one **serialized appender** assigns `seq` in
durable-commit order and fans out only after commit — no assignment/commit race. A
below-retention `since` is rejected at subscribe time via `ack.error:
since_below_retention`; the standalone `resync_required` frame covers the mid-stream case
(retention advancing past a long-idle subscription). Subscribe
(optionally with exclusive `since`) → **ack** with `replay_through_seq` → replay ≤ boundary →
live > boundary; exact cutover, no duplicates within a subscription. Filtered streams have
global-seq gaps by design (not loss). Slow consumers get a bounded queue; overflow emits a
**gap frame** (heal via `since`) or a coded close — never silent drop. `since` below retention
→ **resync_required** (re-read state from the query plane). Grant changes re-fence live
sockets: affected subscriptions are torn down, not honored from a stale snapshot. The 15s
heartbeat frame carries `seq_head` + per-source ingest lag — "everything is fine" requires the
heartbeat fresh AND ingest flowing, not just a live socket.

### 4.2 Standing subscriptions + escalation

`schemas/subscription.schema.json`: `{pattern, filter?, tier, loud, window, note, owner, storm?}`.
Digests are **server-assembled** per owner+window (a digest emission per batch;
`digest.failed` on assembly failure; `next_digest_at` echoed in `/delivery`). Interrupt tier
is validated (`interrupt_ineligible` otherwise) and reserved per /task/709. Delivery is Matrix
by default; every delivery lands a `delivery.receipt` emission **scoped `user:<owner>`**
(target addresses are PII) with pinned dimensions `{tier, signal_ref, status, error_code?,
channel}`. **Delivery-time re-check**: digest assembly and interrupt/Matrix dispatch re-check
the owner's grant set (zookie-current) at SEND time, not subscription-creation time — the
standing-subscription analog of the WS re-fence. Client-side DigestGroup counts may drift
from a server batch on `digest.failed`; the digest emission is the truth. Storm damping: a Feed
subscription exceeding 60 events in the rolling five-minute lake receipt window auto-mutes for
one hour to Digest through the `signal.snooze` action attributed to `system:bus`. The projected
`storm` record retains the measured count, window, expiry, threshold, prior tier, and attribution.
Humans and agents end the active override through that same audited `signal.snooze` operation,
which restores the prior tier through the same projection.

The live Matrix adapter is configured as one fail-closed set:
`CONSOLE_API_MATRIX_HOMESERVER` (an HTTPS origin), `CONSOLE_API_MATRIX_ACCESS_TOKEN`, and
`CONSOLE_API_MATRIX_OWNER_BINDINGS` (JSON mapping console principal ids to their verified Matrix
user ids). A user-id target must equal that binding. A room target is accepted only when both the
delivery account and the bound user are joined. Missing configuration yields an honest failed
operation; it never produces a synthetic delivered receipt.

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
   grant — relation `editor` on the scope + producer registration). The in-process console-api
   may write only a `subscription.changed` entity whose owner exactly names its matching
   `user:<owner>` or `agent:<owner>` scope; this narrow system-action path supports audited
   per-principal storm expiry without granting the service every user scope.
4. **Severity cap** per producer capability (agents can't mint `p0` outside their own scope).
5. **Rate + registry caps**: per-producer emit rate, new-type registration rate (quarantine +
   curation proposal on breach), cardinality caps (schema bounds).
6. **Type-prefix allowlists, default-deny**: every producer registration carries the list of
   type prefixes it may emit (normative, not advisory). In particular, **any type appearing
   in any catalog `emits[]` is accepted only from that op's gating executor's registration** —
   a producer cannot forge an async op-completion (falsely closing a pending op id and
   corrupting `audit.op.outcome`) or synthesize `agent.crashed` attention storms, even inside
   its own scope.

Producer failure rule: `/emit` unavailable ⇒ producers keep a **bounded local spool and retry
with the same emission id** (dedup makes this safe); on shed they drop oldest-debug-first and
emit `emissions.dropped` on recovery. Accepted (`202 {seq}`) = durable + fanned out.

### 4.4 Bridging as-built producers (fleet-bus aggregation)

Bridges are **per-box processes POSTing to `/emit`** (local buffering for free; the .14
console-api tail is only for .14-local sources). Bridges ride the same emit validation path as
everyone (scope-required, schema-validated, distinct `bridge` producer registrations) — no
direct lake writes. Delivery guarantees, per source:

| Source                               | Types                                                                                                      | Guarantee                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/fleet/<handle>.json` (per box) | `fleet.event.*`                                                                                            | **snapshot semantics, lossy by construction** (file = latest event; events between polls are lost) — documented; native manager/hook emit replaces it early in Phase 1                                                                                                                                                                   |
| manager heartbeat files              | `agent.heartbeat` (state-change + ≥15s keepalive, **never 1:1 at 1s**), `agent.crashed`, `channel.lockout` | state-change exact; keepalive sampled                                                                                                                                                                                                                                                                                                    |
| dispatcher card lifecycle            | `card.*`, comms events                                                                                     | **read-only SQLite poll** (no triggers, no second writer — DP2); cursor on `updated_at_ms` + card fence                                                                                                                                                                                                                                  |
| control-plane spool events           | `governance.action`, `fleet.mode`, `discipline.nag`, `usage.report`                                        | at-least-once from spool lines; deterministic ids dedup                                                                                                                                                                                                                                                                                  |
| `~/.claude/shared/system-outbox/`    | recognized local messages → `host.disk.pct`, `container.update_available`; unrecognized → `bot.message`    | at-least-once; authz-relevant subject is fixed to local `.14`/`system-outbox` (claimed targets are labels); malformed/permission-denied/oversize/non-regular records are metadata-only quarantined and emit `bridge.gap_detected`; **the Matrix warning path is NOT decommissioned until `lake.disk.watermark` has fired in anger once** |
| tracker events table                 | `task.*`, `artifact.created`                                                                               | at-least-once from the event log id cursor                                                                                                                                                                                                                                                                                               |

Bridge mechanics (normative): deterministic **UUIDv5 emission ids** (source+cursor/content
hash) so restarts cannot double-land; durable cursors advance only after the POST is accepted
(a crash between accept and checkpoint safely re-POSTs the same id); `bridge.gap_detected` /
`bridge.cursor_reset` emitted whenever loss is possible;
`bridge.source.unreachable` when a box goes dark (a dark box is a signal, not an absence).
Stable poison records do not stall a source: the bridge records only source cursor, emission id,
and error class in `bridge_dead_letter` (never the secret-bearing payload), emits
`bridge.gap_detected`, then advances over that quarantined record. Transient append failures do
not advance the cursor and retry with the deterministic id.
Filenames are represented outside the writer-only cursor table only by deterministic opaque refs,
so token-shaped names cannot leak to or poison the bus. Cursor reconciliation persists both the
count and digest of names at/below the watermark; pruning plus a late lower-sorting insert cannot
hide behind an unchanged count. `box.update_status_changed` remains exclusive to its catalog
gating executor and is never synthesized from system-outbox prose.
Scope stamping: the narrowest scope serving the surfaces bound to that type (tiebreak rule).
**Comms emission mapping** (the Envelope/comms-log binding): types `comms.card | comms.rpc |
comms.mail`; dimensions `method, in_reply_to, recipient, requires_reply, thread, card_id`
(card_id joins letter-click → the `/cards` drill); `source.agent` = sender; `subject` =
recipient; bodies/output tails via `body_ref` (scope-checked blob). Full session transcripts
are **Phase 5** (bus-published by the per-user manager), explicitly not before.

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
failure). 71 ops across 27 namespaces; per-op: lane, `authz` (rule/relation/scope templates),
single gating executor, JSON-Schema args, effect, emits, confirm/destructive/undo/reason
flags, `human_only`, `testable`, phase, lineage. Spec-name drift lives in
`spec_name_aliases` (`terminal.open`→`term.watch`, `governance.pause` and
`governance.override`→`governance.action`, `research`→`kb.research`,
`dashboard.set-home`→`dashboard.set_home`). Alias notation: a value like
`governance.action{action:pause}` means "this wire op with that arg preset" — aliases are
documentation for spec readers, never wire names (CI validates only the op part).

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
true, proposal_task_id}}` — a stable shape; owners promote via the normal tracker flow. The
Phase 4 primitive is active on the live dashboard/grant mutation surfaces. Global catalog-op
activation awaits the inherited N1c `/op` router (dated in `BLOCKERS.md`); console-api does not
publish a proposal-only facade in its place.

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

Phase 3 is live (2026-07-13):

- `GET /api/v1/grants?object=<scope-or-item-ref>` returns
  `schemas/grant-list.schema.json`. Only a current `owner` of the object can enumerate its
  subjects; for `item:<id>`, owning the item's containing scope also authorizes sharing.
- `POST /api/v1/grants` accepts `schemas/grant-mutation.schema.json`. Grant/revoke is owner-gated,
  object-serialized, audit-preserving (revokes invalidate rows rather than deleting them), and
  idempotent by principal + client UUID; body drift is `id_reused`.
- Every committed grant-set change receives a database-sequenced monotonic zookie, updates the
  singleton grant-set head, and emits a transactional PostgreSQL notification. Principal zookies
  are decimal strings (never lossy JavaScript numbers) and always name the **global** comparison
  point, including for principals with no grants. Open bearer WebSockets synchronously stop and
  resync every old-epoch subscription on that notification before asynchronously resolving the new
  Principal; a 30s token-revocation fallback fence remains.
- `item:<id>` viewer grants are enforced by `items_min` RLS, so they reveal that item shell only;
  they do not imply its containing scope. Saved panel queries still re-run as the viewer and refuse
  when the viewer lacks the underlying statistic scopes.
- An `agent:<handle>` principal has exactly its intrinsic same-named private scope before explicit
  grants. `console-api-mint-token ... agent --owner <human>` atomically establishes owner edges for
  the agent and its human. Intrinsic visibility/emit ownership is not item-write or grant-admin
  authority; those require the stored edge. Fleet remains flat and is never implied.
- Emission now requires the intersection of producer registration **and** a current
  unconditional `editor|operator|owner` grant on the emitted scope (the intrinsic agent scope
  counts only for the matching agent). A viewer or conditional grant alone can never emit.

### 7.3 Permission levels

Phase 4 is live (2026-07-13). Tier rows are `{name, authentik_group, description,
default_relations, propose_only}` and seed owner/moderator/collaborator/guest; adding a level is an
insert, with no code-name allowlist. `GET /api/v1/tiers` returns
`schemas/tier-list.schema.json` for user/share pickers.

The strongest configured `default_relations` entry resolves overlapping `principal.tiers`, which the
current production-capable bearer path server-stamps from `api_tokens`; owner/moderator therefore
remain commit-capable without hard-coded tier names, and an equal-strength ambiguity fails closed to
propose-only when any tied row requires it. Trusted Authentik forward-auth mapping for browser humans
is not yet active and remains an upstream deployment prerequisite; dev headers exist only behind
`CONSOLE_API_DEV_AUTH`.
Bootstrap inserts missing baseline rows
but never overwrites configured levels on later deploys. A propose-only caller's dashboard and grant
mutations first prove the target is currently visible, then are filed through the tracker's canonical
bearer-authenticated `file` RPC as an inbox idea and return the §5.2 `op-result` shape with
`result: {proposed: true, proposal_task_id}`; no console mutation is committed. The client UUID is
deduplicated per principal and body drift is `id_reused`. A durable dispatch state plus the
co-located read-only tracker source reconciles external-success/local-failure outcomes by UUID, so a
retry cannot file a second idea. Secret-shaped proposal content is rejected before dispatch. If the
tracker writer is absent or down, the mutation fails closed with retryable `tracker_unavailable`.
Configure the writer atomically with `TRACKER_RPC_URL`, `TRACKER_RPC_TOKEN`, and
`TRACKER_PROPOSAL_PROJECT`; production URLs must be HTTPS and `TRACKER_DB_PATH` is required as the
reconciliation oracle. A current, unconditional, **direct** `editor|operator|owner` resource grant is the explicit
elevation beyond propose-only and permits the normal commit path; tier-inherited grants retain the
tier's default posture. Terminal stays human-only regardless of tier (structural, not a grant).

The same bearer-authenticated tracker RPC is the live command adapter for `task.claim`. Console-api
passes the requested task id and optional capability to the tracker's canonical `claim` operation; the
tracker owns the guarded todo→doing update, lease mint, and fence increment. Console-api verifies that
the returned task id is the requested id, maps an empty result to `claim_lost`, and strips the lease
capability token before constructing the browser-facing op result. The Work surface invokes this path
through a SvelteKit remote command, never a browser-origin fetch.

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
session runtime is live in Phase 5 (2026-07-13):

- `POST /api/v1/assistant/messages` (`schemas/assistant-message.schema.json` →
  `schemas/assistant-message-result.schema.json`) idempotently ensures one specialized Claude Code
  manager session per server-stamped principal and sends the message to that real session.
- `POST /api/v1/assistant/context` (`schemas/assistant-context.schema.json`) delivers the selected
  mark as the most recent `context` message in the same session. `GET /api/v1/assistant/session`
  returns the caller's current manager session state, window layout, and last selected context.
- The manager receives a rotating 15-minute credential for the Streamable-HTTP-style JSON-RPC MCP
  endpoint at `POST /api/v1/assistant/mcp`; it never receives the user's browser/API credential.
  Every tool call re-resolves the principal's current ReBAC scopes. The six tools are
  `stats.query`, `viz.render`, `text.surface`, `window.arrange`, `dashboard.manage`
  (save/load/set-home), and `context.receive`; each binds the existing query, render, or Library
  implementation, while window/context state is durably held in the per-user session registry.
  Mutating dashboard calls pass through the same propose-not-commit policy as the public dashboard
  route; `set_home` includes a UUID `request_id` for proposal/idempotency fencing.
- Configure the seam atomically with `CONSOLE_ASSISTANT_MANAGER_URL`,
  `CONSOLE_ASSISTANT_MANAGER_TOKEN`, and `CONSOLE_API_PUBLIC_URL`. Both URLs must use HTTPS outside
  dev-auth. Missing/down configuration fails closed; the stateless `/api/v1/ask` compiler remains a
  separate grounded single-question endpoint rather than pretending to be a Claude Code session.
  The manager contract MUST deduplicate `(external_session_id, message_id)` and expose
  `POST /v1/sessions/{id}/messages/lookup`; console-api reconciles durable `dispatching` rows against
  that receipt before any retry, closing remote-success/local-crash ambiguity without storing prose.

## 10. Observability of the surface itself

Every request/op/emit is an emission per Rule 8 (with Rule 8's anti-recursion + sampling; the
`Authorization` header and `term.input` bodies are never captured). Glitchtip carries
_exceptions_; the lake carries _events_ — one error, both places, by class not by duplication
(exception→Glitchtip + a `console.api.error` emission without the stack). Retention classes
are contractual: `audit.*`, `term.*`, `edge.*`, security events **including admin/term-lane
authorization denials** ≥1y (archived, never blanket-purged); raw telemetry 30d; rollups 1y. `lake.disk.watermark` is a Phase 1 crack
source with an emergency retention-shrink runbook.

Shipped L1 behavior: console-api initializes the GlitchTip/Sentry channel only when
`CONSOLE_API_GLITCHTIP_DSN` is set (inert otherwise). HTTP failures are sent to GlitchTip and also
land as stack-free `console.api.error`; bounded request metadata lands as sampled
`console.api.request`. Authorization headers and request/response bodies are never captured.
If GlitchTip is inert or unavailable, failures to emit these self-statistics also produce a bounded,
secret-free structured stderr record; they are never silently swallowed.

## 11. Out of scope for P0 (lands in the named phase)

`GET /graph` walk endpoint (Phase 2; edge _storage_ Phase 1) · doorman deep shapes (Phase 1 with
`PetalNet/doorman`) · PTY + `service.logs` stream
framing (Phase 1, Terminal spec owns frames; audit-before-first-frame generalized in §5.1) ·
librarian autonomy (own effort) · view registration governance (Phase 2). Full transcript export to
the lake via scope-checked `body_ref` remains a follow-on to the live Phase 5 session seam; the
runtime persists only request hashes, dispatch state, and manager receipt IDs for recovery—not
transcript or tool-result bodies—and does not put message bodies into statistic dimensions or logs.

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
