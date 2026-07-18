# ADR: Unified SvelteKit console substrate

- **Status:** Accepted
- **Date:** 2026-07-16
- **Decision owner:** Eli
- **Supersedes:** [Console gateway language and service boundary](../ADR-GATEWAY-SERVICE.md)
- **Contracts:** [CONSOLE-CONTRACTS.md](../contracts/CONSOLE-CONTRACTS.md)

## Context

`apps/console` is the lab's all-in-one agentic management platform: the single place to provision,
store, and manage agents across the fleet, and to operate the systems they run on. Its UI and
TypeScript gateway were previously separate applications even though they shared a release,
authentication spine, contract vocabulary, and operator workflow. That packaging added a
cross-process browser client, CORS, and deployment state without centralizing agent management.
Provisioning, agent storage, and agent management are first-class console capabilities.
Data-querying and bridging other data sources (Manager, control-plane, box-agent, tracker,
Library) is a secondary capability the console grows over time — it extends the platform, it is
not a boundary the console is fenced out of.

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

## Centralization boundaries

The console centralizes agent provisioning, storage, and management as first-class capabilities.
Where a system already owns its state, the console integrates it: bridging that source is the
secondary, current path, and the console may centralize more of it over time.

| Boundary                   | Current data source           | Console responsibility                                                                      | Centralization stance                                                    |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Fleet and manager state    | Manager and per-box producers | Ingest registered emissions, project scoped reads, dispatch signed idempotent operations   | First-class: the console provisions, observes, and manages the fleet and its agents |
| Governance and fleet mode  | control-plane                 | Translate contracted commands and emissions, expose scoped projections                     | First-class management surface; control-plane remains the executing engine |
| Host operations            | box-agent                     | Route authorized host, service, and update envelopes; observe signed completion            | First-class management surface; box-agent remains the host executor      |
| Tasks                      | tracker                       | Read through the tracker adapter, map visibility to console scopes, dispatch canonical RPC | May centralize task and agent-work storage and management here; bridging the tracker is the secondary path |
| Library                    | Library plane/store           | Expose versioned items, links, search, curation, and projections                           | May centralize item storage and curation here; bridging the existing Library is the secondary path |
| Legacy and per-box sources | bridge adapters               | Normalize emissions, preserve deterministic IDs/cursors, and report gaps                    | Secondary and additive: bridging further data sources extends the platform, it does not define it |

Adapters may translate transport, normalize identifiers, enforce current scopes, and attach
freshness/provenance. They never invent success or derive authorization from UI state.

## Consequences

- Console deploys and rolls back as one Node artifact with one auth and telemetry spine.
- Browser reads no longer choose mock/live modes or construct gateway URLs.
- Contract and adapter-conformance tests remain release gates because packaging changed but source
  of truth ownership did not.
- Active-active sequence allocation and cross-process fan-out remain out of scope and require a
  new decision.
