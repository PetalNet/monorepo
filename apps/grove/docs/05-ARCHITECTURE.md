# Grove architecture

**Status:** Focused implementation view  
**Normative source:** `01-GROVE-BUILD-SPEC.md`  
**Implementation baseline:** `sip-mega-export/console/console-monorepo-current-daca287a`

This is an evolution plan for the current architecture. It is not permission to replace working foundations with a greenfield system.

## 1. Architectural outcome

Grove ships as one Grove Site service with internally bounded parts:

- one install, upgrade, health, backup, and recovery story;
- one identity and authorization spine;
- one participant application and one Admin surface;
- one Library data substrate;
- one Task authority inside the Library domain;
- one command plane across UI, MCP, REST, and internal workflows;
- one durable event model;
- separately supervised components where isolation is operationally necessary;
- the current host implementation reused for additional hosts.

“One service” is a product and operations boundary, not a demand for one process or one source directory.

## 2. Current implementation baseline

The accepted base is commit/export `daca287a`.

### Repository rules to preserve

The current monorepo uses:

- `apps/*` for deployable units;
- `packages/*` for shared libraries used by multiple apps;
- `tools/*` for repository-only scripts and operations;
- apps depending on packages, never directly on other apps;
- `vp run` for the workspace task graph and cache;
- CI gates for typecheck, lint, test, build, workspace consistency, type synchronization, and dead-code checks.

Do not bypass these rules to make the Grove change appear smaller.

### Unified Console to preserve

`apps/console` is already one full-stack SvelteKit application.

Its server-side domain services live under:

`apps/console/src/lib/server/domain`

Its public surfaces derive from the same domain layer:

- SvelteKit Remote Functions for the UI;
- `/api/v1/**` REST/OpenAPI;
- `/api/v1/mcp` and assistant MCP;
- SvelteKit-owned WebSockets.

The current architecture intentionally has:

- one Node artifact for the Console;
- one auth and telemetry spine;
- transport-agnostic Effect services;
- Effect Schema as the contract source;
- `@effect/sql-pg` behind the current database facade;
- scoped PostgreSQL access and RLS;
- typed bus/RPC contracts;
- ordered replay, resume cursors, gaps, backpressure, and grant revalidation.

These are foundations, not migration debris.

### Existing authoritative components

The source export contains:

- `apps/manager`
- `apps/control-plane`
- `apps/box-agent`
- `apps/dispatcher`
- `apps/courier`
- `apps/console`
- supporting deployables and packages

Their existing lease, fencing, signing, idempotency, supervision, and host-operation behavior must be preserved by contract tests while product boundaries are folded into the Grove Site.

### Current domain seam

The accepted Console ADR currently describes:

- tracker as Task authority;
- Library plane/store as Library authority;
- Console adapters as non-authoritative.

The target decision supersedes only the Task/Library authority split:

- the Library domain becomes the sole Task authority;
- tracker-named adapters remain temporary compatibility seams;
- Console remains a projection and command surface rather than inventing domain state;
- no second Task writer is introduced.

The migration must explicitly move authority. Renaming an adapter is not enough.

## 3. Current-to-target map

| Area              | Current base                                          | Target change                                                                         |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Console packaging | unified full-stack SvelteKit Node app                 | preserve; become participant + Admin Grove shell                                      |
| Domain layer      | Effect services under Console server                  | preserve patterns; add Library Task module and shared commands                        |
| Task authority    | tracker via adapter                                   | migrate into Library Task module, then retire legacy authority                        |
| Library           | items, revisions, links, search, curation projections | become universal Grove object graph with signed immutable Versions                    |
| Versions          | current revision support                              | strengthen with content address, parent Versions, canonical serialization, signatures |
| Records           | historical design concept                             | eliminate; use typed objects, Versions, and relationships                             |
| Rooms             | incomplete/product concept                            | Task-anchored collaboration using Matrix transport                                    |
| Agent operations  | existing manager/dispatcher/host components           | preserve runtime safety; add durable Agent identity and semantic continuity           |
| Commands          | audited operation plane plus current domain seams     | one command surface across every transport                                            |
| Events            | ordered bus, projections, telemetry                   | preserve; distinguish domain facts from telemetry and chat                            |
| Product packaging | multiple deployable applications                      | present as one Grove Site lifecycle while retaining necessary process isolation       |
| Federation        | not core                                              | later boundary adapter; A2A optional, never internal authority                        |

## 4. System boundaries

### Participant shell

The participant-facing surface owns:

- Home;
- private Ask/Capture;
- Library browsing and search;
- typed object pages;
- Project/Task planning and review;
- Rooms;
- private UI agent interaction.

It does not own authoritative domain state. It issues commands and reads projections.

### Admin

Admin preserves the current operational lenses:

- Cockpit;
- Work;
- Agents;
- Hosts;
- Observability;
- Signals;
- Network;
- Updates;
- Library administration;
- authorized terminal.

Admin uses the same commands and projections as programmatic clients.

### Library domain

The Library domain owns:

- stable object identity;
- immutable Versions;
- typed relationships;
- visibility and publication;
- search and retrieval;
- curation and prominence;
- provenance;
- Task graph, state, Attempts, Claims, reviews, and approvals;
- object-level policy decisions.

The domain may have internal modules. It remains one authority.

### Execution plane

Manager, dispatcher, control-plane, box-agent, courier, and related runtime components own or enforce operational execution contracts such as:

- Runtime allocation;
- supervision;
- lease and fencing enforcement;
- placement;
- host mutation;
- command delivery;
- liveness;
- signed completion transport;
- retry and reconciliation mechanics.

They do not own Task meaning or completion.

### Matrix collaboration boundary

Matrix provides Room transport and interoperability:

- transport-level membership enforcement;
- event delivery;
- raw event history;
- BYO Matrix clients/accounts;
- channel-like lanes.

Grove owns:

- Grove Room identity and lifecycle;
- the anchoring Task;
- the authorized Grove member set;
- Grove authorization;
- official Task and Library actions;
- the mapping between Matrix events and Grove objects;
- retention and history-visibility policy;
- presence grants;
- Room projections and summaries.

The bridge reconciles the Grove member set to Matrix membership. Matrix membership never grants Grove data or operation authority by itself. Matrix messages do not directly mutate Task authority.

## 5. Authority matrix

| Concern                                                           | Authoritative owner                            | Projections/adapters                        |
| ----------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| object identity and Version chain                                 | Library                                        | Console, search, federation                 |
| visibility and publication                                        | Library                                        | UI, Matrix presentation                     |
| Task graph and lifecycle                                          | Library Task module                            | UI Work views, legacy tracker adapter       |
| Attempt meaning and result                                        | Library Task module                            | execution plane reports signed evidence     |
| Claim policy and Task exclusivity                                 | Library Task module with execution enforcement | manager/dispatcher/runtime adapters         |
| Runtime liveness and placement                                    | execution plane                                | Admin and Task projection                   |
| host/service mutation                                             | box-agent/host operations contract             | Console/Admin                               |
| governance/fleet policy                                           | control-plane                                  | Console and command adapters                |
| Grove Room lifecycle, member policy, history visibility, presence | Grove Room module                              | Matrix membership/event projection          |
| conversation event order/content                                  | Matrix event history                           | Grove Room projection                       |
| official action from a Room                                       | Grove command plane                            | Matrix bot/bridge                           |
| search relevance                                                  | Library retrieval service                      | participant and agent clients               |
| prominence/curation                                               | Librarian policy and signed curation objects   | Home and Library views                      |
| telemetry                                                         | observability/event pipeline                   | Admin                                       |
| federation exchange                                               | boundary adapter                               | local Library remains authoritative locally |

If two rows appear to own the same state, stop and resolve the contract before implementation.

## 6. Data architecture

### PostgreSQL

PostgreSQL remains the system of record for Grove domain state.

The current migration already includes Library items, revisions, links, and RLS. Evolve these rather than starting a parallel generic-object database.

Target logical structures:

- `library_objects`
- `library_versions`
- `library_relationships`
- `tasks`
- `task_dependencies`
- `attempts`
- `claims`
- `reviews`
- `approvals`
- `room_bindings`
- `agent_identities`
- `runtime_bindings`
- `signing_keys`
- `idempotency_keys`
- transactional outbox and projection checkpoints

Names are illustrative until reconciled with current schema conventions. Logical ownership is normative.

### Stable object and immutable Version

A stable object row holds minimal identity and current-head metadata.

A Version contains:

- object ID;
- parent Version IDs;
- schema/type identifier;
- canonical payload;
- content digest;
- author or producer;
- causal context;
- creation time;
- signature envelope;
- visibility-relevant metadata where policy requires it.

Updating an object creates a Version and advances the head through optimistic concurrency. It never mutates historical content.

### Relationships

Relationships are typed and attributable. Where a relationship carries meaning that can change, it is itself versioned or represented as a versioned object.

Do not store provenance in an untyped JSON bag.

### Time-series and telemetry

Keep operational telemetry distinct from authoritative domain facts.

- domain commands and facts live in transactional Grove storage and its durable event path;
- high-volume telemetry may use the current time-series facilities;
- telemetry cannot become the only evidence for Task completion;
- projections clearly report freshness and source.

### Search

Search indexes:

- exact IDs and aliases;
- titles and content;
- object types;
- relationships;
- visibility;
- current heads;
- pinned historical Versions where relevant.

Indexing is asynchronous but observable. Reads that require authority use PostgreSQL/domain queries, not a potentially stale search index.

## 7. Command, event, and query model

### Commands

Every authoritative change is a command handled in the owning domain.

All command entry points require:

- authenticated principal;
- scoped authorization;
- Effect Schema validation;
- idempotency key;
- optimistic concurrency or expected Version where relevant;
- audit and causal context;
- structured result.

Remote Functions, REST, MCP, Room integrations, and internal workflows call the same handlers.

### Events

On successful transaction:

1. domain state changes;
2. immutable Version and relationship changes are stored;
3. outbox facts are stored atomically;
4. publisher emits ordered facts;
5. projections update idempotently;
6. clients receive replayable changes.

No handler reports success before its authoritative transaction commits.

### Queries

Queries return:

- data;
- authoritative object and Version IDs;
- visibility context;
- source/provenance;
- projection timestamp or cursor;
- stale or partial status.

No UI infers authority from the presence of a row.

## 8. Transport

Preserve the current transport split:

- Remote Functions for the first-party UI;
- versioned REST/OpenAPI for general integrations;
- MCP for agents;
- WebSocket for replayable live projections;
- Matrix for conversation.

Transport adapters:

- decode and validate;
- authenticate;
- authorize or pass scoped identity;
- attach idempotency and causal context;
- call domain services;
- map typed results.

They do not duplicate business logic.

### Actor authentication spine

Browser OIDC and MCP machine OAuth terminate at separate protected-resource ingress modules. Browser login binds a Person by the verified issuer-qualified subject. MCP validates bearer tokens without consulting browser cookies, resolves the machine identity to an Agent, and exposes only currently authorized operations. An enrollment-scoped but unbound machine identity is a restricted bootstrap principal until it explicitly enrolls itself.

The local Home Host owner is deployment-pinned by browser `(issuer, subject)`. Owner-unbound is a visible readiness state and does not disable login, so the configured owner can establish the binding. Agent placement and ownership remain stable when execution moves between Runners.

Every transport stamps the invocation Actor and context before calling a named domain command. Commands reauthorize at invocation time. Agent capability changes and Person authority reductions preserve capability containment or return typed conflicts with explicit remediation choices; revocation and lifecycle safety still fail closed immediately. The Sprout demo operations are a fixed first-slice compatibility policy for every active Actor and cannot be removed through authority mutation.

## 9. Agent, Runtime, and host architecture

### Agent

Agent is durable semantic identity:

- stable identity and keys;
- role and capabilities;
- policy;
- memory references;
- model preferences;
- history and relationships;
- dormancy state.

### Runtime

Runtime is temporary execution:

- host;
- process/session/container identity;
- model resolved for the Attempt;
- tools and credentials;
- lease;
- fencing token;
- heartbeat;
- Attempt binding;
- checkpoint and terminal evidence.

One Agent may have many sequential Runtimes. Concurrent Runtimes require explicit policy and distinct Claims.

### Hosts

Additional machines run the same host implementation as the primary Site’s host boundary.

Use host profiles for capability and placement, for example:

- local lightweight;
- GPU;
- isolated high-risk;
- browser-enabled;
- heavy cloud;
- offline/private.

Do not create a second host product for remote machines.

### Model resolution

Model selection is resolved per Task or Attempt using:

- required capability;
- user preference;
- budget;
- latency;
- privacy;
- provider availability;
- policy.

The selected model is recorded as execution evidence, not baked into Agent identity.

## 10. Rooms and Matrix

Each Room binds to one anchor Task.

A Project can have:

- one broad coordination Room;
- focused Rooms for branches or subtasks;
- temporary review or incident lanes.

Official actions from a Room use explicit commands. A Matrix event may carry or link to:

- a Task reference;
- a pinned Version;
- an approval or review;
- an invocation;
- a result summary.

Raw runtime logs, bus events, RPC chatter, and routine telemetry do not flood conversation.

The Room bridge must be:

- idempotent;
- loop-safe;
- permission-aware;
- able to reconcile edit/redaction semantics;
- explicit about history visibility;
- resilient to temporary Matrix unavailability.

## 11. Signing and verification

### Purpose

Signatures prove content integrity and attribution to a key. They do not prove that a claim is true or a decision is wise.

### Required signed material

At minimum:

- Library Versions;
- authoritative relationship changes;
- Task lifecycle decisions;
- Attempt results;
- reviews and approvals;
- external action receipts;
- federation envelopes.

### Canonicalization

Use Grove Version Envelope v1 from the master specification:

- RFC 8785/JCS UTF-8 payload;
- SHA-256 `sha256:<lowercase-hex>` digests and Version IDs;
- Ed25519 Site/domain keys;
- DSSE v1 with payload type `application/vnd.grove.version.v1+jcs`;
- lexicographically sorted parent Version IDs;
- schema-defined set ordering;
- RFC 3339 UTC millisecond timestamps;
- schema-level Unicode NFC normalization for human text before JCS, with opaque strings excluded;
- schema-defined strings for non-interoperable JSON integers and precision-sensitive decimals;
- explicit omitted-versus-null semantics.

Use golden vectors across every language that signs or verifies. No component substitutes ordinary `JSON.stringify` or language-native map order for canonicalization.

### Key lifecycle

Support:

- key creation;
- public-key discovery;
- rotation;
- revocation;
- historical verification;
- compromised-key annotation;
- recovery and escrow policy where allowed.

Key rotation must not invalidate historical Versions.

## 12. Security

- Keep current bearer, session, and machine-principal pathways coherent.
- Resolve authorization at command time.
- Revalidate long-lived WebSocket grants as current code does.
- Enforce PostgreSQL RLS as defense in depth.
- Scope service credentials to their component.
- Never place provider secrets in Library payloads, Matrix messages, logs, or signed public envelopes.
- Bind Claims to fencing tokens.
- Use constant-time signature comparisons through vetted libraries.
- Treat imported/federated content as untrusted.
- Sanitize rendered Markdown and external artifacts.
- Audit Admin terminal access and destructive host operations.

## 13. Deployment and operations

The Grove Site presents:

- one installer;
- one release version;
- one compatibility matrix;
- one health summary;
- one backup and restore operation;
- one upgrade orchestration;
- one rollback decision.

Internally it may run multiple supervised processes and databases.

Health must distinguish:

- Site unavailable;
- participant UI unavailable;
- command plane unavailable;
- Library degraded;
- search lagging;
- Matrix bridge degraded;
- execution capacity unavailable;
- individual host or provider degraded.

Do not flatten partial failure into one green/red light.

Backup covers authoritative PostgreSQL data, signing material under the appropriate security policy, configuration, and required Matrix mapping state. Search indexes and disposable Runtimes are rebuildable.

## 14. Migration plan

### Phase 0 — freeze the base

- record `daca287a` as the implementation baseline;
- make current gates green;
- add characterization tests around Task, Library, operation, lease, fence, and adapter behavior;
- inventory all tracker and Library writes;
- define stable ID mapping.

### Phase 1 — strengthen Library Versions

- add canonical payload and content digest;
- add parent Version lineage;
- add signature envelope and key tables;
- adapt current revisions without breaking reads;
- ship verification tooling and golden vectors;
- keep current heads and history queryable.

### Phase 2 — add Library Task module

- implement Task graph, completion contracts, Attempt, Claim, review, and approval commands;
- expose them through the existing Effect domain patterns;
- build projections compatible with existing Work reads;
- keep new writes disabled until parity and migration are proven.

### Phase 3 — move Task authority once

- freeze legacy direct writers;
- migrate Tasks, dependencies, leases/claims, and links;
- activate Library Task commands;
- make tracker-named adapters delegate to Library Task authority;
- compare projections and audit results;
- provide rollback by restoring the old single writer, never by enabling both.

### Phase 4 — first vertical product slice

Ship:

- Home Ask/Capture;
- Project creation;
- planning/grilling;
- a small DAG;
- one Agent Attempt;
- one human or review step;
- a versioned output;
- verified completion;
- Library retrieval and provenance.

### Phase 5 — Rooms and Site lifecycle

- bind Task Rooms through Matrix;
- add explicit Room command actions;
- add one Grove Site install/health/upgrade presentation;
- retain internally supervised processes.

### Phase 6 — design completeness and curation

- complete object pages and views;
- add prominence and curation;
- strengthen Personal/Grove publication;
- remove tracker terminology from product and dead code;
- delete old stores only after data, references, and rollback windows are satisfied.

### Phase 7 — adapters and federation

- add A2A only as a boundary adapter if a concrete interoperability need exists;
- add federation envelopes and policy;
- preserve local authority and verification.

## 15. Architectural gates

Required checks:

- no app-to-app source dependency;
- one implementation of every authoritative command;
- no direct legacy Task writer after cutover;
- no separate Record table/API/UI object introduced;
- schema and migration tests;
- cycle and readiness property tests;
- lease/fence concurrency tests;
- command idempotency tests;
- outbox and projection replay tests;
- signature golden vectors;
- key rotation and revocation tests;
- RLS and authorization tests;
- adapter-conformance tests;
- REST/OpenAPI/MCP/Remote Function parity tests;
- WebSocket replay, gap, resume, and grant-reference tests;
- Matrix bridge idempotency and loop tests;
- backup/restore rehearsal;
- upgrade and rollback rehearsal;
- current CI gates remain green.

## 16. Explicit non-goals

Do not:

- build another frontend or gateway beside `apps/console`;
- move domain logic into Svelte components or route handlers;
- treat Matrix as the Task database;
- treat search as authoritative;
- replace working manager/dispatcher/host safety semantics;
- turn every internal process into a user-visible product;
- use federation or A2A inside the local core;
- split Personal and Grove into different object systems;
- maintain old tracker and new Task writers concurrently;
- introduce a generic Record wrapper;
- claim the current code already implements signed content-addressed Versions when it does not.
