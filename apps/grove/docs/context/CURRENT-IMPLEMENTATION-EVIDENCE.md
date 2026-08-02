# Current implementation evidence

**Purpose:** Code-grounded evidence used to keep the Grove specification aligned with the actual architecture.  
**Baseline:** `sip-mega-export/console/console-monorepo-current-daca287a`

This document is descriptive, not normative. `../01-GROVE-BUILD-SPEC.md` owns the target decisions.

## 1. Source selection

The export itself identifies the current source:

- `sip-mega-export/console/_CURRENT-SOURCE-NOTE.md:1-5`
- it names `console-monorepo-current-daca287a/`;
- it identifies commit `daca287a`;
- it says the other console directories are earlier snapshots, audits, and design history.

Conclusion: design documents were reconciled against this source, not against an older console snapshot.

## 2. Monorepo architecture

Evidence:

- `docs/ARCHITECTURE.md:5-21` defines `apps/*`, `packages/*`, and `tools/*`;
- `docs/ARCHITECTURE.md:21` prohibits apps from depending directly on other apps;
- `docs/ARCHITECTURE.md:23-37` defines the `vp run` workspace graph and content-addressed cache;
- `docs/ARCHITECTURE.md:48-50` lists CI gates.

Conclusion: Grove changes should keep the existing dependency layout and task runner. A new app may not import implementation code from another app.

## 3. Unified SvelteKit Console

Evidence:

- `apps/console/docs/adr/UNIFIED-SVELTEKIT-CONSOLE.md:1-6` marks the ADR accepted;
- lines `20-25` define `apps/console` as one full-stack Console with transport-agnostic Effect domain services and a single PostgreSQL layer;
- lines `27-38` define Remote Functions, REST/OpenAPI, and MCP as surfaces over that layer;
- lines `40-43` reject a second server/browser HTTP client and locate typed contracts;
- lines `47-59` define SvelteKit-owned WebSockets, replay, heartbeats, backpressure gaps, scopes, and grant revalidation;
- lines `77-82` say Console deploys as one Node artifact and keeps contract/adaptor conformance as release gates.

Conclusion: the participant Grove shell belongs in the current SvelteKit application. Adding another frontend, gateway, or browser-specific authority would reverse an accepted and implemented decision.

## 4. Current authority split

Evidence:

- `apps/console/docs/adr/UNIFIED-SVELTEKIT-CONSOLE.md:61-73` gives the current adapter boundary table;
- line `68` names tracker as Task authority;
- line `69` names Library plane/store as Library authority;
- lines `72-73` prohibit adapters from inventing success or deriving authorization from UI state.

Conclusion:

- the final Grove decision does change a current boundary;
- it must be implemented as an explicit authority migration;
- Console must remain a command/projection layer;
- a temporary tracker adapter is legitimate;
- a permanent tracker/Library split or dual writer is not.

## 5. Current tracker seam

Evidence:

- `apps/console/src/lib/server/domain/reads/tracker.ts:1-9` describes tracker as a single-writer SQLite store and Console as read-only;
- lines `28-34` map native Task visibility to caller scopes;
- lines `36-49` strip lease secrets from public projection;
- lines `69-75` open SQLite read-only;
- lines `126-159` read Tasks, closed history, and active leases;
- `apps/console/src/lib/server/domain/commands/tracker.ts:31-44` describes a narrow bearer-authenticated command adapter;
- lines `46-100` call the tracker’s canonical claim RPC and validate the result.

Conclusion: current tracker reads and commands are concrete migration seams. The target Task module should first satisfy their behavior and then make them delegate, rather than deleting them at the start.

## 6. Existing Library substrate

Evidence in `apps/console/migrations/0002_console_domain.sql`:

- lines `714-738` create `library_items` with stable ID-like fields, kind, scope, status, payload, integer version, and timestamps;
- lines `768-779` default `entity_id` to `id`;
- lines `790-793` add scoped and full-text search indexes;
- lines `795-808` create typed `library_links`;
- lines `810-833` create revision snapshots and the revision trigger;
- lines `899-905` enable and force RLS on Library items and links;
- lines `1012-1026` create scoped read and writer policies.

Evidence in `apps/console/src/lib/server/domain/dashboard/store.ts`:

- lines `710-729` read one Library item with freshness metadata;
- lines `731-755` return Library item revision history;
- lines `758-764` distinguish work and knowledge status sets;
- lines `770-829` use a transaction, expected version, and explicit conflict handling for status changes;
- lines `832-874` list typed Library links with scoped reads and freshness.

Conclusion:

- Grove already has a useful Library substrate;
- target Versions should evolve current revisions;
- target relationships should evolve current links;
- existing RLS and optimistic conflict behavior should be preserved and strengthened;
- the current substrate is not yet the final signed, content-addressed Version model.

## 7. Task-shaped Library items are not yet Task authority

Evidence:

- `apps/console/src/lib/server/domain/dashboard/store.ts:758-764` defines work statuses;
- lines `785-795` treat `kind === "task"` as a status-specialized Library item;
- lines `817-828` directly update the Library item version/status.

At the same time:

- the accepted ADR still assigns Task authority to tracker;
- tracker reads use a separate SQLite store;
- tracker claims use its RPC writer.

Conclusion: the current code contains both a tracker Task seam and Task-shaped Library items. This is a consistency hazard, not evidence that authority has already moved. Migration must inventory and close every write path before cutover.

## 8. Lease, fencing, and idempotency foundations

Evidence:

- `apps/dispatcher/DECISIONS-dispatcher.md:22-25` states that lease expiry does not prove a worker stopped and requires a fence on every write;
- lines `40-45` describe the dispatcher store, guarded claim/renew/complete/deliver updates, and fence increment on reap;
- `apps/manager/docs/contracts/CONTRACTS.md:119-135` defines atomic claims, expiry, required monotonic fences, stale-worker rejection, and public/private lease projections;
- lines `153-175` define the RPC envelope ID as an idempotency key and show it through dispatch;
- `apps/manager/docs/contracts/DECISIONS.md:123-130` records required monotonic fences, secret claim tokens, and idempotent RPC deduplication.

Conclusion: the final Task/Claim model must preserve and centralize these safety properties. A simpler status-only queue would regress validated behavior.

## 9. Current process boundaries

The current source contains these deployable components:

- `apps/manager`
- `apps/control-plane`
- `apps/box-agent`
- `apps/dispatcher`
- `apps/courier`
- `apps/console`
- `apps/clarity-mcp`
- `apps/collegemap`
- `apps/point`
- `apps/slide`

Conclusion: “one Grove Site” cannot safely mean deleting process boundaries on sight. It means one product and operations lifecycle around internally bounded components, followed by consolidation only where contracts and failure isolation support it.

## 10. UI foundations

Evidence:

- `apps/console/package.json:36-53` includes DaisyUI, Tailwind, and the Tailwind Vite integration;
- `apps/console/vite.config.ts:24-28` configures Tailwind plus Geist and Geist Mono;
- `apps/console/src/app.css:10-23` sets up self-hosted fonts, Tailwind, and DaisyUI;
- `apps/console/src/app.css:212-213` sets the Geist font variables;
- `apps/console/src/lib/components/icons.ts:77-85` defines a tree-shakeable Lucide-only icon registry and rejects emoji/inline SVG as the UI convention;
- `apps/console/docs/adr/UNIFIED-SVELTEKIT-CONSOLE.md:126-129` records verified self-hosted Geist output.

Conclusion: the final UI design is an extension of the current SvelteKit/Tailwind/DaisyUI/Geist/Lucide foundation, not a new design stack.

## 11. Current mechanisms worth retaining

The accepted Console ADR and source show:

- one domain layer across UI and programmatic transports;
- Effect Schema contract validation;
- scoped PostgreSQL access and RLS;
- typed bus frames;
- ordered replay and resume;
- backpressure gaps;
- grant-change revalidation;
- audited command execution;
- adapter conformance tests;
- explicit freshness in Library projections;
- expected-version conflict handling.

The Grove build should extend these mechanisms before adding substitutes.

## 12. Current gaps the target must actually implement

The inspected current source does not establish all of the final model. Required target work includes:

- Library as sole Task authority;
- Project as Task role;
- deep Task hierarchy and hard dependency DAG;
- distinct Task, Attempt, Claim, and workflow lifecycles;
- completion contracts and independent verification;
- durable Agent identity separated from temporary Runtime;
- immutable content-addressed signed Versions with parent lineage;
- first-class versioned reviews and approvals;
- canonical serialization and key lifecycle;
- Personal and Grove realms as one object system;
- Task-anchored Rooms with Matrix interoperability;
- one Grove Site install/health/upgrade presentation;
- elimination of tracker and Record terminology from the final product model.

Conclusion: these are target requirements, not claims about current behavior.

## 13. Implementation warning

The most dangerous migration shortcut is to infer that current `library_items(kind='task')` already makes Library the Task authority. It does not. The accepted architecture and live adapters still point elsewhere.

Required proof before cutover:

1. every current Task writer is inventoried;
2. the new Task command surface passes contract and concurrency tests;
3. identifiers and Task history are mapped;
4. current reads and claim behavior are projected from the new authority;
5. legacy writes are frozen;
6. one cutover switches authority;
7. no interval exists in which both stores accept independent Task writes.
