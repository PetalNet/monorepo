# ADR: Unified SvelteKit console substrate

- **Status:** Accepted
- **Date:** 2026-07-16
- **Decision owner:** Eli
- **Supersedes:** [Console gateway language and service boundary](../ADR-GATEWAY-SERVICE.md)
- **Contracts:** [CONSOLE-CONTRACTS.md](../contracts/CONSOLE-CONTRACTS.md)

## Context

The console UI and its TypeScript gateway were separate applications even though they shared a
release, authentication spine, contract vocabulary, and operator workflow. That packaging added a
cross-process browser client, CORS and deployment state without creating an authoritative domain
boundary. The actual authorities remain Manager, control-plane, box-agent, tracker, Library, and
the bridge sources.

## Decision

`apps/console` is the one full-stack Lab Console application. The lake, ordered broker, projector,
ingest, attention, assistant, cost, notification, registry, semantic, query, availability, network,
tracker, and bridge adapters run inside its Node server process as transport-agnostic Effect
services in `src/lib/server/domain`.

Three public surfaces derive from that one domain layer:

1. SvelteKit remote functions are the UI RPC boundary.
2. `/api/v1/**` is the versioned REST boundary; its handlers use SER `Handler` and delegate to the
   same canonical Effects as remote functions. `/api/v1/openapi.json` is assembled from the
   canonical contract JSON Schemas.
3. `/api/v1/mcp` is the in-process MCP JSON-RPC endpoint. Its tools call the same scoped query,
   dashboard, Library, and command services.

There is no Fastify server and no separate `console-api` package, process, health boundary, CORS
boundary, or browser HTTP client.

## WebSocket server

Adapter-node does not expose an upgrade hook. Production therefore starts `build-server/index.js`,
a small custom Node wrapper that creates the HTTP server, mounts adapter-node's
`build/handler.js`, initializes the single domain substrate, and attaches `/api/v1/bus/ws` and
`/api/v1/terminal/ws` upgrades. `pnpm dev` uses the matching Vite server plugin so development and
production exercise the same broker attachment. The shared process-global service promise ensures
the SvelteKit handler and upgrade listeners use one broker and one subscription fence.

The bus preserves broker replay boundaries, ordered delivery, resume cursors, backpressure gaps,
per-principal scopes, and grant-change revalidation. WebSocket authentication resolves the same
Better Auth session table and principal scopes used at HTTP request boundaries.

## Adapter boundaries

| Boundary                   | Authoritative owner           | Console adapter responsibility                                                             | The console must not become                                    |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Fleet and manager state    | Manager and per-box producers | Ingest registered emissions, project scoped reads, dispatch signed idempotent operations   | A supervisor, session owner, or manager command implementation |
| Governance and fleet mode  | control-plane                 | Translate contracted commands and emissions, expose scoped projections                     | A policy engine or canonical governance writer                 |
| Host operations            | box-agent                     | Route authorized host, service, and update envelopes; observe signed completion            | Host mutation logic or an execution authority                  |
| Tasks                      | tracker                       | Read through the tracker adapter, map visibility to console scopes, dispatch canonical RPC | A task/lease writer or competing task store                    |
| Library                    | Library plane/store           | Expose versioned items, links, search, curation, and projections                           | A second librarian or competing canonical item model           |
| Legacy and per-box sources | bridge adapters               | Normalize emissions, preserve deterministic IDs/cursors, and report gaps                   | A source of inferred domain decisions                          |

Adapters may translate transport, normalize identifiers, enforce current scopes, and attach
freshness/provenance. They never invent success or derive authorization from UI state.

## Consequences

- Console deploys and rolls back as one Node artifact with one auth and telemetry spine.
- Browser reads no longer choose mock/live modes or construct gateway URLs.
- Contract and adapter-conformance tests remain release gates because packaging changed but source
  of truth ownership did not.
- Active-active sequence allocation and cross-process fan-out remain out of scope and require a
  new decision.

## Rewrite decisions (feat/console-rewrite, 2026-07-19)

Running log; one line per non-obvious call, appended phase by phase.

### Phase 1 — Fastify excision

- REST surface: the entire Fastify route table was ported 1:1 into a framework-agnostic Web-standard core (`src/lib/server/api/console-api.ts`); `src/routes/api/v1/[...path]/+server.ts` delegates every method to it. The SER remote functions stay the UI's typed layer; REST keeps Fastify-parity shapes (tests + external consumers assert them), so overlapping URLs (roster, catalog, health, attention) now serve the richer Fastify contract instead of the thinner interim SvelteKit one.
- CORS + origin-deny: folded into the core for `/api/v1/*` (active only when a better-auth verifier with `consoleOrigin` is configured) — not into `hooks.server.ts`, so page routes keep SvelteKit's own CSRF posture.
- Rate limiting: the per-principal token bucket (30/min, 429 + retry-after) moved into the core's dispatch for `POST /op` and all terminal routes — same counters, one limiter, no SvelteKit `Handle` twin.
- Auth: the core keeps the Fastify chain (bearer → better-auth verifier → dev header, incl. `resolveHumanIdentity` authentik-group mapping). The browser UI keeps the SvelteKit better-auth session model (`locals.user.tier`). Both principal models coexist deliberately: unifying them is a redesign, not an excision. `hooks.server.ts` no longer login-redirects `/api/v1/*` so machine clients get 401 JSON.
- Bus WS: the Fastify bus handler (heartbeats, frame-contract validation, 64-sub limit, unsubscribe, grant re-fence with principal re-resolution) is the canonical behavior, extracted to `domain/bus/connection.ts`; `ws.ts` (runtime) and the test harness both attach it. The old `ws.ts` message loop (close-on-invalid, no heartbeat, stale-scope revalidate) was a behavior subset/bug and is gone. Prod WS auth: session resolver first, then the core chain (adds Fastify-parity bearer support for agents).
- Tests: `pipeline.test.ts` + `release-acceptance.test.ts` drive the folded core through `test/harness/surface.ts` (inject = direct `api.fetch`; WS/NDJSON over a real Node listener attached to the same core). Assertions preserved; only the transport swapped.
- `readPlaneRemote("attention")` now applies the contracted lane filter (viewer principals don't see operator-lane items) — the interim SvelteKit surface had dropped it relative to the Fastify read routes.
- The observability boom test drives the shared error handler through `/api/v1/tiers` with a detonating scoped-read connection instead of registering an ad-hoc Fastify route; assertions unchanged.
- `resolveBearer` no longer crashes (TypeError → 500) on an unknown/revoked token — `rows.at(0)` null-guard restores the intended 401 contract. Latent Fastify-era bug, reachable on any auth'd route with a bad bearer.
- Request telemetry (`console.api.request`) is emitted fire-and-forget after the response, matching Fastify's onResponse timing; the error-path emission stays awaited before the 500 (as Fastify's setErrorHandler did).
- Contract JSON (ops.json + schemas) is compiled into the server bundle via `import.meta.glob` behind a virtual `contract://console/` base — the built server has no source tree on disk, which broke the old `import.meta.url` file reads. The dev vite plugin loads the API core through `ssrLoadModule` so the config bundle (esbuild, no glob support) never evaluates it.
- `executeNamedOp` (SER remote) now dispatches through `executeOpPlane` — the identical command plane as `POST /api/v1/op` (catalog, authz, proposals, audit, capabilities) — replacing the interim stub that faked dry-runs and only knew `task.claim`.
- `/api/v1/mcp` kept as an interim-surface alias (any authenticated principal) alongside the tool-token `/api/v1/assistant/mcp` route.

### Phase 2 — WebSockets: svelte-ws foundation, crossws transport, typed RPC package

- `packages/svelte-ws` vendors github.com/sowahq/svelte-ws (MIT, attribution in its README/LICENSE) with three adaptations: transport swapped from `ws` to crossws (`crossws/adapters/node`), the adapter's re-bundle step moved from raw rollup to Vite's SSR build (no new bundler toolchain), and per-route `_websocket.ts`/Bun/Cloudflare support dropped (one Node target, one `handleWebsocket` hook). The adapter also preserves adapter-node's `instrumentation.server.js` entry (Sentry tracing), which upstream predates.
- SvelteKit owns the upgrade end to end: `src/hooks.server.ts` exports `handleWebsocket` (bus + terminal paths), the vendored vite plugin serves it in dev, and the adapter appends the crossws attachment to `build/index.js`. The bespoke `server/index.ts`, `server/vite-plugin.ts`, `server/principal.ts`, and `vite.server.config.ts` are deleted; `start` is now `node build/index.js`, and the substrate registers its own SIGTERM/SIGINT shutdown (the wrapper used to).
- Bus protocol preserved byte-for-byte: `domain/bus/connection.ts` (Phase 1's transport-agnostic extraction) is attached unchanged; the session-cookie WS resolver moved to `src/lib/server/session-principal.ts` (Headers-based) with the core auth chain as fallback.
- `packages/console-bus-rpc` (`@petalnet/console-bus-rpc`): Effect Schema definitions for every bus frame (subscribe/unsubscribe/ack/event/resync_required/gap/heartbeat) plus OpCall/OpResult/QueryRequest/QueryResult, a reconnecting `connectBusClient` that schema-decodes every inbound frame (protocol errors surfaced, never coerced), and typed `executeOpCall`/`executeQuery` REST helpers. The console UI's `connectBus` now delegates to it — the ad-hoc `JSON.parse` + shape-guard loop is gone.
- `ws`/`@types/ws` removed from the console and the workspace catalog (crossws bundles its own protocol internals). Test WebSockets: the harness bridges the bus in-memory (WHATWG sockets cannot carry auth headers), and the real upgrade path is exercised by the boot smoke (unauthenticated connect → contract `unauthorized` ack + close) plus `test/domain/bus-rpc.test.ts` driving subscribe/event/resync/grant-refence/unsubscribe through the typed client.

### Phase 3 — one pg layer: @effect/sql-pg
- `domain/db/pool.ts` rebuilt on `@effect/sql-pg` `PgClient` behind the same promise tagged-template `Sql` facade the whole domain already speaks — an excision keeps hundreds of call sites byte-identical instead of rewriting them into Effect. Transactions reserve a dedicated connection via `client.reserve` and route every statement through the client's transaction service, so a transaction handle IS `Sql`: the `tx as unknown as Sql` cast is gone structurally, not hidden.
- Facade semantics matched to the old driver where pg differs: `.json()` pre-stringifies (pg would serialize a JS array param as a Postgres array literal, not JSON); rejections unwrap the `SqlError` chain to the driver error so `permission denied`-style assertions and message classification keep working; `.listen()` runs the PgClient LISTEN stream on a forked fiber with an `unlisten` handle.
- `openDb` became async (PgClient acquisition is effectful); `buildServices` awaits it. `openSql` serves standalone clients (session verifier, scripts, tests) — the better-auth verifier and the temp-DB test bootstrap now go through it, so `postgres`/postgres-js is gone from the entire app including tests, and from the workspace catalog. Ordered security migrations (three roles, RLS, hand-authored SQL) run unchanged through the facade; `effectdb migrate` was already @effect/sql-pg-based.
