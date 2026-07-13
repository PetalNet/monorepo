# ADR: Console gateway language and service boundary

- **Status:** Accepted
- **Date:** 2026-07-13
- **Decision owners:** maintainers of `apps/console-api`
- **Scope:** `console-api` runtime, deployment, and integration boundary
- **Related contracts:** [`contracts/CONSOLE-CONTRACTS.md`](contracts/CONSOLE-CONTRACTS.md)

## Context

The original board grounding described `apps/console-api` as a Rust backend at the Fleet and
Manager seam. The implemented service is instead a Node 22, TypeScript, and Fastify application.
Leaving that change implicit makes the service easy to operate as though it were one of the Rust
fleet daemons and makes gateway adapters easy to mistake for new sources of truth.

The Console needs one HTTP and WebSocket boundary over several independently owned systems. It
also needs runtime schema validation, the TypeScript render and assistant code, and direct reuse
of the monorepo's web tooling. Those concerns have a different release and failure boundary from
the long-running host and agent daemons.

## Decision

`apps/console-api` is intentionally a **TypeScript gateway and console substrate**, deployed as
its own Node service. It owns the Console's versioned HTTP/WebSocket surface, authentication and
principal resolution at that surface, ReBAC enforcement, the event lake and ordered bus,
Console-owned projections, and orchestration of named operations. The schemas under
[`docs/contracts`](contracts/) are the language-neutral boundary.

It is not Fleet Manager rewritten in TypeScript. Manager, control-plane, box-agent, tracker, and
other domain services remain authoritative for their state and operations. `console-api` reads,
projects, or dispatches through contracted adapters and fails closed when an authoritative
service is unavailable.

### Why this does not belong in an existing Rust crate

- `apps/manager` owns per-agent sessions, supervision, and manager command execution.
- `apps/control-plane` owns governance and fleet-mode state.
- `apps/box-agent` owns host-local execution.
- The tracker remains the single writer for task state.

Putting the public Console API into any one of those crates would give that domain service
dependencies on browser protocols, the lake, render/assistant code, and every other executor. It
would also couple their deployment and failure domains. A new Rust gateway would avoid that
coupling, but would duplicate the TypeScript render/assistant stack and monorepo web validation
tooling without changing the network contracts. Rust remains the right implementation language
for the resident daemons and host adapters; service boundaries, rather than FFI or shared process
state, connect them to the gateway.

## Deployment and ownership

The `console-api` service owner is responsible for all of the following as one deployment unit:

- the Node 22 process built from `apps/console-api`, including database migrations;
- the Console lake/Postgres roles and the single serialized sequence writer;
- Traefik routing and the dedicated Authentik forward-auth middleware;
- the `/api/v1/health` watchdog contract, resource limits, and restart policy;
- `CONSOLE_API_GLITCHTIP_DSN` configuration and gateway error telemetry; and
- compatibility of the HTTP, WebSocket, emission, and named-operation contracts.

The production deployment target is one active gateway instance under systemd with
`Restart=always`, a health watchdog, and a 2 GiB memory limit, behind Traefik. Single-instance
operation is deliberate at the current LAN scale because the gateway is the sole sequence
writer. An upgrade creates a brief planned gap; clients resume from `since`. A gateway outage
makes Console surfaces honestly dark or stale, while Matrix remains the emergency command and
P0-alert floor. A lake outage makes operations fail closed with `audit_unavailable`, and
producers retain bounded retry spools.

Owners of the Rust services continue to own their processes, durable state, command handlers,
deduplication, and rollback procedures. The gateway owner owns only the adapter and contract on
the Console side of each boundary. A change spanning both sides requires both owners to validate
the language-neutral contract; it does not transfer source-of-truth ownership to the gateway.

## Adapter boundaries

| Boundary                         | Authoritative owner               | Gateway/adapter responsibility                                                                                             | Must not be reimplemented in `console-api`                                    |
| -------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Fleet and manager state          | manager and its per-box producers | ingest registered emissions; project scoped reads; dispatch signed, idempotent named-op envelopes                          | supervision, session ownership, channel locking, or manager command semantics |
| Governance and fleet mode        | control-plane                     | translate the contracted command/emission envelope and expose scoped projections                                           | policy decisions or canonical governance state                                |
| Host operations                  | box-agent                         | route authorized `host.*`, `service.*`, and `updates.*` envelopes; observe signed completion                               | host mutation logic, allowlists, or execution state                           |
| Tasks                            | tracker                           | use tracker HTTP/RPC helpers, map tracker visibility to Console scopes, and reconcile by operation ID                      | task lifecycle, leases, or task persistence                                   |
| Library                          | Library plane/store               | expose the versioned item/link/search contract and project results into Console reads                                      | a second librarian, tool registry, or competing canonical item model          |
| Legacy and per-box event sources | bridge adapters                   | normalize to the emission schema, attach registered producer identity, preserve deterministic IDs/cursors, and report gaps | domain decisions inferred from files, prose, or snapshots                     |

Adapters may translate transport, normalize identifiers, enforce the caller's current scopes,
and add freshness/provenance metadata. They may not invent success, become a second writer, or
derive domain authorization from UI state. Native emitters can replace bridge transports over
time without changing the emission contract.

## Consequences

- Operators must use the Node/systemd/Traefik/Postgres runbook for `console-api`, not a Rust
  daemon runbook merely because adjacent Fleet services are Rust.
- The gateway has an intentionally broad read/orchestration role, so its authn, ReBAC/RLS,
  producer registration, secret scrubbing, and two-phase audit checks remain release gates.
- Cross-language integration tests should exercise schemas and observable contract behavior;
  sharing internal Rust or TypeScript types across the boundary is not required.
- A future multi-instance gateway requires a separate decision for sequence allocation,
  fan-out, and subscription fencing. This ADR does not authorize active-active deployment.
- Moving domain logic into the gateway, or moving the gateway into a Rust daemon, requires a
  superseding ADR with ownership, migration, rollback, and failure-mode changes.
