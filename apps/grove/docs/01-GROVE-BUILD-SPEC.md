# Grove build-ready specification

**Status:** Authoritative implementation target  
**Version:** 1.0  
**Prepared:** 2026-07-23  
**Implementation base:** `console/console-monorepo-current-daca287a`  
**Decision horizon:** Wayfinder and Eli corrections through 2026-07-22

This is the rectified Grove specification. It replaces the historical SIP Mega unified spec as the implementation-facing product and architecture authority.

Supporting files in this package are views of this document. If they disagree, this document wins.

---

## 1. Product definition

Grove is a human-centered operating environment for collaborative, agentic work.

It combines:

- a universal Library and personal/shared PKM;
- recursive Task planning and durable execution;
- Rooms where people and selected agents collaborate;
- agents with durable identity and movable, supervised Runtimes;
- local and enrolled-host execution;
- strong provenance, versioning, signatures, and retrieval;
- one participant and operator product deployed as one Grove Site service.

The product is not “AI in chat,” a task tracker beside a document vault, or a fleet dashboard exposed to ordinary users.

The product promise is:

> Start with an ask, turn it into accountable work, let humans and agents carry it through a verifiable DAG, and preserve the useful result in a shared information field that makes the next Project smarter.

### 1.1 North-star workflow

```text
Open or create a Project
→ write an Ask/Task
→ Librarian files it in the Library
→ Planner expands it into a Task DAG
→ ambiguity opens a grilling session
→ ready Tasks fan out to authorized agents or automations
→ research is requested through the Librarian
→ documents, code, PRs, approvals, and other outputs link to their Tasks
→ independent review verifies the result
→ completion contract is satisfied
→ accepted output Versions contribute under their visibility/publication policy
→ future work retrieves and cites them
```

### 1.2 Product principles

1. **The outcome is the product.** Agents are means, not the center of the experience.
2. **Library is the shared field.** Projects do work in the Library; they do not own separate Libraries.
3. **Work is a DAG.** Task dependencies and child relationships are explicit.
4. **Authority is deliberate.** Conversation can propose; only explicit domain operations change official state.
5. **Private first.** User-facing assistants and Ask/Capture begin private.
6. **Accepted work compounds without crossing privacy.** Grove-realm Project outputs contribute back to shared knowledge; Personal output remains Personal until an explicit action or standing policy publishes it.
7. **Stable identity, immutable history.** Durable objects change by adding signed Versions.
8. **Current state must be current.** Stale authority cannot continue acting.
9. **One service, many parts.** Grove has one operational boundary and internal bounded authorities.
10. **Open standards at boundaries.** Matrix, MCP, Git, and optional A2A integrations do not define Grove's core model.

---

## 2. Canonical terms

### Grove Site

One independently administered Grove installation. It has one release version, installer, configuration model, participant/operator entry point, health surface, backup/restore story, upgrade, and rollback.

A Site may run several supervised processes and may enroll additional hosts.

### Library

Grove's universal durable object graph, shared PKM, discovery system, citation layer, and primary data substrate.

The Library contains or addresses Tasks, Rooms, Agents, people, documents, research, sources, decisions, artifacts, capabilities, messages, reviews, approvals, comments, and other durable objects.

The Library is not merely an index over a separate Tracker.

### Library object

A durable logical identity with:

- a stable object ID;
- one type and optional roles;
- an immutable Version history;
- typed relationships;
- an authority module;
- a visibility realm and ACL;
- human and agent representations;
- living and pinned references.

### Version

An immutable, canonical representation of one object state.

Every accepted Version has:

- a stable object ID;
- a Version ID;
- parent Version IDs;
- canonical schema/type;
- canonical payload or content digest;
- relationship changes or pinned relationship facts;
- actor identity;
- accepting authority identity;
- timestamp and logical ordering;
- content hash;
- signature or verification bundle;
- optional external artifact, Git, or transparency references.

An object's current head is a mutable reference to an immutable Version. Updating an object creates a Version and advances the head atomically.

### Task

The durable unit of accountable work. A Task holds intent, scope, relationships, plan, policy, completion contract, and authoritative lifecycle.

Every explicit agent invocation is backed by a Task.

### Project

A Task carrying the `project` role and governance profile, usually the root of a substantial Task branch.

Project is not a separate work primitive.

### Attempt

One execution run against a Task. It records the assigned Agent, Runtime, host, model, Claim/fence, workspace, workflow run, checkpoints, evidence, and result.

A Task may have zero or many Attempts.

### Claim

A temporary, authoritative, fenced lease allowing one Attempt to work on a Task. Claims expire, renew, release, revoke, or are superseded.

### Workflow run

An optional durable execution mechanism beneath an Attempt. It may execute steps, timers, retries, callbacks, approval waits, and external actions.

Workflow engines implement execution; they do not own Task identity or decide Task completion.

### Room

A durable, human-readable collaboration context anchored to one Task branch. It carries conversation, presence, history, and Room policy.

A Room does not own Task truth, host execution, tools, or artifact truth.

### Agent

A durable principal composed from scope, role, lifecycle, capabilities, memory, model, placement, supervision, and budget profiles.

### Runtime

A temporary running instance of an Agent on a Grove host. One Agent normally has one active Runtime, protected by an exclusive lease and generation fence.

### Approval, review, comment, message, artifact

First-class versioned objects linked to the relevant Task, Attempt, Room, actor, and subject Version.

They are not wrapped in a generic Record object.

---

## 3. Recordicide: the final provenance model

Grove has no `Record` domain object.

Earlier designs used Record to mean workflow, event, vertex, edge, receipt, provenance link, activity bundle, or signature wrapper. That abstraction duplicated information already owned by Tasks, Versions, messages, approvals, artifacts, and typed links.

The final model is:

```text
Stable object identity
→ immutable Version
→ content hash
→ signature(s)
→ typed relationships to exact object Versions
```

### 3.1 What is signed

Everything meaningful is verifiable:

- each accepted object Version is signed by its accepting Grove authority;
- agent proposals/results are attributable to the Agent principal and Runtime generation;
- human approvals and policy changes carry the human's verified authorization;
- artifact Versions pin exact content digests;
- code outputs pin commits, checks, PRs, and merges;
- Site releases and exports have signed manifests;
- optional external transparency receipts can attest inclusion without becoming domain truth.

Signing does not mean a human confirmation prompt for every mutation. Site and domain authorities sign automatically inside their grants. Human signatures are required when human authority is the fact being asserted.

### 3.2 Provenance without Records

Provenance is the subgraph formed by versioned objects and typed links:

```text
Room message Version
  └── prompted → Task Version

Task Version
  ├── planned-as → child Task Versions
  ├── attempted-by → Attempt Version
  ├── cited → source/document Versions
  └── produced → artifact/document Version

Review Version
  └── reviewed → exact artifact Version

Approval Version
  └── accepted → exact result Version

Task closing Version
  └── satisfied-by → approval/review/result Versions
```

No detached Record is necessary.

### 3.3 Canonical serialization

Grove Version Envelope v1 uses:

- UTF-8 JSON Canonicalization Scheme, RFC 8785/JCS, for signed payload bytes;
- SHA-256 for Version and external-content digests, encoded as lowercase `sha256:<hex>`;
- Ed25519 Site/domain signing keys;
- DSSE v1 envelopes with payload type `application/vnd.grove.version.v1+jcs`.

The canonical payload includes the schema identifier, stable object ID, canonical object payload, lexicographically sorted parent Version IDs, canonical relationship facts/changes, actor principal, accepting authority, and timestamp. Timestamps are RFC 3339 UTC strings with millisecond precision. Integers outside JSON's interoperable safe range and precision-sensitive decimals are schema-defined strings. Schema normalization converts human-text fields to Unicode NFC before JCS; opaque strings and external bytes are never silently normalized.

Array order is preserved when it is meaningful. Fields declared as sets are sorted by their canonical encoded bytes before the enclosing payload is canonicalized. Null and omitted are distinct according to the object schema.

The Version ID is the SHA-256 digest of the canonical payload bytes. External bytes have separate digests and are never folded into JSON through an unstable encoding. The DSSE signature covers the exact canonical payload and therefore its parent IDs and pinned relationship facts.

Human-authorized facts include the authenticated actor and authorization evidence in the canonical payload; the accepting authority signs the Version. WebAuthn or another direct human-held signature may be added for high-risk policy without changing Version identity rules.

Verification works offline from Site trust material. Every envelope carries a key ID; key rotation preserves retired public keys and validity intervals so historical verification remains possible.

Sigstore-compatible bundles may accompany DSSE envelopes. Public Rekor logging is optional and must not leak private Grove content.

---

## 4. Information architecture and UX

### 4.1 Participant shell

The ordinary participant experience has three persistent concepts:

- **Home** for private Ask/Capture, attention, and continuation;
- **Library** for universal navigation, search, objects, and shared knowledge;
- **Admin** for Site operation, hosts, models, security, and observability when the user is authorized.

Rooms, Tasks, Projects, Agents, people, documents, and artifacts are first-class object pages and Library lenses. They do not need permanent top-level silos.

The global palette and Ask/Capture can open any authorized object directly. Recents, pins, backlinks, saved views, and semantic search prevent users from hunting through hundreds of Projects.

### 4.2 Home

Home is private and user-scoped.

Its first control is one **Ask/Capture** composer that can:

- ask a question;
- find an object;
- capture a note or idea;
- create a Task or Project;
- start research;
- create or open a Room;
- attach a file;
- invoke a private UI agent;
- schedule or automate work.

As the user types, Grove shows a quiet, editable interpretation:

```text
Ask Personal Librarian · Private
Create Task in Oak · Grove
Start research · Private invocation Task
Publish note to Grove · Confirmation required
```

Nothing becomes shared or state-changing because of ambiguous natural language.

Below Ask/Capture is one adaptive area:

- **Needs You** when Grove cannot safely continue or conclude without the user;
- **Continue** when nothing requires action but active or pinned work is useful;
- **All caught up.** when neither applies.

Needs You is an action queue, not a notification feed. Each item states what is required, why, and what happens if the user does nothing. It resolves from authoritative source state regardless of whether the resolution occurs in the UI, a Room, or an agent action.

### 4.3 Library navigation

Library is the universal explorer:

- ask/search;
- type and relationship filters;
- backlinks and related objects;
- living Topic pages;
- saved views and collections;
- graph, table, timeline, board, and document lenses;
- exact version history and provenance;
- pinned citations;
- per-user held items and recommendations.

Full graph visualization is optional exploration, not the default interface.

### 4.4 Object pages

Every object page follows one frame:

1. identity, type, roles, current status, visibility;
2. current Version and verification state;
3. type-specific primary experience;
4. related objects and backlinks;
5. provenance and exact sources;
6. version history and comparison;
7. allowed operations;
8. responsible humans and Agents.

Type-specific pages include:

- **Project Task:** purpose, completion contract, active Task DAG, Rooms, people/Agents, outputs, decisions, attention.
- **Task:** intent, plan/DAG position, Attempt history, Claim, result, completion contract, evidence, reviews.
- **Room:** conversation, anchor Task, visible Task lanes, participants, agent presence, history/policy.
- **Agent:** identity, roles, lifecycle, current Runtime, assignments, Rooms, model/placement policy, history.
- **Document/research/decision:** content, citations, sources, trust/freshness, related Tasks and Topics.
- **Artifact:** exact bytes/digest, versions, producer Attempt, review, distribution.

### 4.5 Private-to-shared publication

Private UI agents work under the user's private Task branch.

Sharing is by value:

```text
Private Task and conversation
→ user publishes selected result
→ new Grove-visible object Version
```

Publication never exposes private conversation, unshared context, drafts, or unrelated tool activity.

---

## 5. Library domain and data model

### 5.1 Scope

The Library is both:

- the universal identity/version/link substrate; and
- the owner of knowledge-facing discovery, search, curation, and citation.

Type-specific bounded modules enforce lifecycle rules inside the Library. The Task module is one of these modules.

This is compatible with one Postgres deployment and strict internal ownership. “One Library” does not mean every module may update every table.

### 5.2 Object classes

The first build must support these types or extensible equivalents:

```text
task
room
agent
person
topic
document
research
source
decision
note
idea
artifact
capability
tool
skill
service
message
comment
review
approval
automation
```

`project` is a Task role, not an independent type.

Types are registered, schema-versioned, and renderer-driven. Do not freeze the Library into one giant SQL enum.

### 5.3 Visibility

Two ordinary visibility realms:

- **Personal:** user-private Tasks, conversations, drafts, memories, and unpublished outputs.
- **Grove:** shared Site-wide information field.

Project, Task, and Room relationships provide origin and context; they are not default Library silos.

Explicit ACL restrictions handle secrets, guests, legal/contractual material, and sensitive data. Authorization is enforced in the data/query layer, not by hiding controls in the UI.

Federated sharing is an explicit publication/grant operation, not a third local visibility realm.

### 5.4 Relationships

Relationships are typed, directional where meaningful, permission-aware, and versionable. The registry defines one canonical stored direction and an inverse display label where useful; writers do not create a second inverse edge as separate truth.

Initial vocabulary includes:

```text
child-of
depends-on
soft-depends-on
blocked-by
prompted
originated-in
supports
cites
derived-from
produced
attempted-by
assigned-to
reviewed-by
approved-by
implements
uses
contributes-to
supersedes
contradicts
related-to
discussed-in
published-from
requires
provides
```

The graph must prevent invalid cycles for hierarchical and dependency relations without banning legitimate cycles for general semantic relationships.

### 5.5 Living references and pinned citations

Living reference:

```text
grove://<site>/<object-id>
```

It resolves to the caller-authorized current head.

Pinned citation:

```text
grove://<site>/<object-id>@<version-id>
```

It resolves to exact signed content.

Conversation and exploration may use living references. Evidence, decisions, accepted outputs, reviews, approvals, external publication, and reproducible Agent context must pin exact Versions automatically.

### 5.6 Search and retrieval

Search combines:

- exact ID and alias lookup;
- text/BM25;
- semantic/vector retrieval;
- typed graph traversal;
- provenance, recency, trust, and permission filters;
- reciprocal-rank or equivalent result fusion.

Every result explains:

1. what it is;
2. why it matched;
3. where it came from;
4. its current/superseded/contradicted state;
5. whether it may be used or shared in the current context.

Weak retrieval returns nothing rather than injecting filler.

Agents and humans use the same Library domain operations. Agents receive structured, permission-filtered context packages; they do not scrape the UI.

### 5.7 Library prominence

Every durable object may be addressable, but not every object receives equal search rank or graph prominence.

Normal Library navigation foregrounds:

- accepted outputs;
- documents, research, sources, ideas, decisions;
- useful artifacts and capabilities;
- Projects, Tasks, Rooms, people, Agents, and Topics;
- Librarian syntheses with provenance.

Routine messages, retries, tool calls, heartbeats, and low-level events remain reachable through parent objects and specialized lenses.

> Referenceability does not imply prominence. Durability does not imply default recall.

### 5.8 Grove and Personal Librarians

**Grove Librarian**

- maintains the shared information field;
- ingests accepted Project contributions;
- adds reversible metadata, aliases, summaries, and links;
- clusters duplicates;
- detects contradictions, stale knowledge, gaps, and orphans;
- creates Topic maps and Project briefing packs;
- improves retrieval;
- proposes merges, retirement, and follow-up work.

It may not silently delete history, publish Personal material, change permissions, rewrite Task/Room/Agent truth, remove provenance, or declare disputed synthesis official.

**Personal Librarian**

- is private user-scoped;
- searches the user's Personal realm plus authorized Grove content;
- maintains private recall, summaries, held items, and views;
- publishes nothing without an explicit user action or standing publication policy.

### 5.9 Project knowledge flywheel

Grove-realm Project-role Tasks have a default shared contribution policy. Personal Project-role Tasks have a realm-preserving contribution policy.

When a Task result is accepted, its output manifest identifies durable contributions. These become new Library objects or Versions in the Task's authorized realm, with full origin, sources, Task, Attempt, actor, and verification links. Moving a Personal contribution into Grove requires an explicit user action or standing publication policy.

Automatic contribution is not automatic belief. Knowledge-bearing content may be provisional, current/preferred, contradicted, superseded, invalidated, or archived. Task and Agent lifecycle states remain type-specific.

### 5.10 Memory

Memory has three layers:

1. **Private activity history:** retained user-private Tasks, conversations, tool activity, outputs, grants, models, and approvals under policy.
2. **Durable memory claims:** qualified statements with source, confidence, sensitivity, validity, and contradiction/supersession links.
3. **Active recall:** the minimum permitted and relevant subset attached to one Task.

Retention is policy-scoped. Retained history is not automatically trusted memory; trusted memory is not automatically active context.

---

## 6. Task DAG and work execution

### 6.1 Graph model

Tasks have:

- one optional hierarchical parent (`child-of`);
- zero or more dependency edges (`depends-on`);
- zero or more blockers (`blocked-by`);
- zero or more children;
- a Project root discovered through ancestry/role;
- links to Rooms, inputs, outputs, people, Agents, reviews, and approvals.

Child depth is unbounded at the domain level. The graph must reject hierarchy and dependency cycles.

The Task DAG is authoritative work structure. Library semantic links may be cyclic and do not change Task readiness unless typed as Task dependencies.

### 6.2 Task fields

At minimum:

- stable object ID and Task Version;
- title and intent;
- role(s): including `project`, `standing`, or ordinary finite Task;
- origin: human, planned, invocation, automation, import;
- parent and dependency relationships;
- status;
- priority and scheduling requirements;
- visibility and ACL;
- responsible human;
- planning policy;
- context/input references;
- completion contract;
- verification policy;
- recovery and retry policy;
- output manifest;
- budget and deadline;
- allowed capabilities, models, providers, and hosts;
- current Claim summary;
- current/previous Attempts;
- signature and provenance metadata.

### 6.3 Task lifecycle

Canonical semantic states:

```text
Draft
→ Planning
→ Planned
→ Ready
→ Active
→ Review
→ Completed

Non-terminal side states:
Blocked
Waiting
Recovery needed

Terminal alternatives:
Cancelled
Abandoned
```

Exact UI labels may vary, but implementation must preserve the distinction between planned, runnable, executing, awaiting verification, and accepted.

`Planning` includes clarification/grilling. `Planned` means the graph and completion contract are accepted but one or more readiness conditions may still be false. `Ready` is derived from the current dependency, input, permission, policy, capacity, and Claim state.

A standing Task may remain Active while children enter and leave. It completes only by an explicit governance decision under its completion contract.

### 6.4 Attempt lifecycle

```text
Starting
→ Running
→ Result submitted
→ Succeeded

Failure exits:
Failed
Fenced
Timed out
Cancelled
Reconciliation needed
```

Attempt success means execution finished and submitted a result. It does not complete the Task by itself.

### 6.5 Claim lifecycle

```text
Leased
→ Released

Failure/authority exits:
Expired
Revoked
Superseded
```

Renewal extends a `Leased` Claim and records a renewal event; it does not create a second semantic state. Every Claim has a monotonically increasing fence/generation. Stale writers are rejected at the authoritative mutation boundary.

### 6.6 Readiness

A Task is ready only when:

- it is in a runnable lifecycle state;
- all required dependency Tasks satisfy their edge conditions;
- required inputs and permissions are available;
- the completion contract is defined enough to verify;
- it has no unresolved blocking edge;
- a compatible Agent/model/host/capability route exists or the Task explicitly waits for one.

### 6.7 Planning and grilling

A new Project Ask enters Planning.

The Planner:

1. reads the Ask and authorized Library context;
2. searches for existing relevant work;
3. proposes Tasks and dependency edges;
4. identifies assumptions, missing decisions, risks, and required approvals;
5. attaches completion contracts and verification policies;
6. validates the DAG.

If material ambiguity remains, Grove opens a bounded grilling session in a private or shared Room appropriate to the Ask. Planning does not fake readiness.

The user, responsible human, or applicable Librarian/governance policy accepts the plan. Acceptance creates signed Task Versions and advances ready nodes.

### 6.8 Execution kinds

A Task or workflow step may be:

- agent prompt/work;
- human work or decision;
- Library research/retrieval;
- code change;
- document/artifact production;
- review or approval wait;
- webhook/API call;
- message/email action;
- deployment;
- timer/schedule;
- manual checkpoint;
- composed child Task DAG.

State-changing external actions require idempotency keys, recorded request/response evidence, and reconciliation behavior.

### 6.9 Completion and verification

Every Task has a completion contract. Examples:

- question: accepted answer delivered;
- research: findings and citations delivered;
- decision: authorized decision and rationale recorded;
- document: exact Version accepted;
- code: commits pushed, required checks pass, independent review accepted, PR merged to the configured target;
- deployment: health and rollback checks pass;
- webhook: authoritative remote acknowledgement received or reconciled;
- human task: authorized human attests completion.

Verification may be automatic, agent-based, human, or mixed. Consequential work may not be self-certified solely by its executor.

### 6.10 Failure and recovery

Attempt failure does not fail the Task by default.

For a confirmed Runtime or host failure:

1. revoke/supersede the Runtime lease;
2. fence the old Claim;
3. preserve Attempt evidence and checkpoints;
4. determine whether retry is safe;
5. create a new Attempt under the same Task;
6. assign a compatible Agent/host/model;
7. reconcile only when external side effects are ambiguous or state is non-transferable.

Recovery policy is bounded by Site maxima, Project/repository profiles, and Task restrictions. The recovering Agent cannot expand those bounds.

### 6.11 Builder workspaces

The logical workspace, branch, and checkpoint lineage belongs to the Task. Each Attempt receives a disposable physical worktree or equivalent execution directory bound to that lineage.

For Git-backed work:

- one Task branch/worktree lineage;
- push WIP checkpoint commits early and at safe boundaries;
- link commit hashes to Attempts;
- treat local worktrees as disposable;
- validate a checkpoint before inheritance;
- attempt bounded repair, then fall back to the newest valid checkpoint;
- PR and merge state are linked objects/Versions;
- no local-only uncommitted state is considered durable.

For non-Git work, use equivalent private snapshots, patches, or artifact Versions.

### 6.12 Workflow implementation boundary

Grove does not expose a workflow engine as the domain model.

The first implementation may use Postgres-backed orchestration, Effect Workflow, or another engine if it satisfies:

- Task remains authoritative in the Library;
- Attempt/Claim fences remain authoritative;
- replay cannot repeat unsafe side effects without idempotency/reconciliation;
- callbacks and timers survive process restarts;
- engine state is inspectable from the Task;
- the engine ships inside the one-Service release boundary;
- replacement does not change public Task semantics.

---

## 7. Rooms and collaboration

### 7.1 Purpose

A Room is where humans and intentionally present agents communicate, guide, decide, and coordinate around one Task branch.

Rooms contain socially meaningful communication, not fleet transport noise.

### 7.2 Anchor and lanes

Every Room has one stable anchor Task.

A broad Room may anchor to a Project root Task and coordinate many concurrent descendant Task lanes. It may spotlight one lane without preventing others.

Sustained work may progressively narrow into another Room anchored to a descendant Task when audience, history, permissions, or focus require it. The Task graph remains the canonical hierarchy.

### 7.3 Lifecycle

Room lifecycle:

```text
Active → Paused → Archived
```

Task completion changes a Room's focus state, not its lifecycle.

Archival suggestions appear only when the Room is non-standing, its relevant branch is complete, future work is not expected, activity is stale, and nobody has marked it to remain open. Suggestions belong in quiet cleanup, not persistent nags.

### 7.4 Conversation versus authority

Humans and agents speak freely.

Official mutations occur only through:

- explicit Grove controls for humans;
- explicit MCP/domain operations for agents;
- validated automations.

Grove does not interpret ordinary speech as an authoritative Task claim, delegation, completion, or permission change.

Accepted official changes may project concise updates into the Room.

### 7.5 Membership and history

Room membership grants communication access only. It does not automatically grant:

- all Tasks under the anchor;
- Library objects;
- tools or hosts;
- secrets;
- private memory;
- agent invocation rights.

History access is a visible Room policy: full, from-join, recent window, curated summary, selected messages, or none.

The Room creator is the initial Steward unless governance says otherwise. Stewards manage Room-level membership, history, presence, and lifecycle within the anchor Task's authority ceiling.

If no Steward remains, existing permitted conversation may continue, but membership and policy changes freeze until governance appoints a replacement.

### 7.6 Agent presence

Three presence forms:

1. **Invocation presence:** bounded context, one Task, then leave.
2. **Temporary presence lease:** time-, message-, meeting-, or Task-bounded participation.
3. **Standing attachment:** named Agent with continuing Room participation, requiring explicit approval unless a higher policy has intentionally pre-authorized it.

Room policy classifies actions as:

- automatic;
- notify;
- confirm;
- denied.

High-trust no-interactive-approval Rooms are permitted within explicit higher-level ceilings. They still require visible presence, attribution, audit, pause, and revocation.

### 7.7 Invocation UX

Natural language may select an invocation preset, but Grove shows its interpretation before execution:

```text
Research
Context: this message + linked Task + 20 recent messages
Tools: Library + web
Output: cited report
Launch: automatic under Room policy
```

Ambiguous requests fall back to respond-only. Sensitive external actions require the applicable policy.

If work exceeds context, cost, duration, tools, or delegation limits, the Agent proposes escalation. It does not expand its own grant.

Room-visible Agents return their result to the Room. Private UI agents return privately.

### 7.8 Matrix

Matrix is the continuity transport and chat interoperability layer.

Grove supports:

- first-party Room UX;
- authorized BYO Matrix clients;
- authorized federated Matrix accounts/MXIDs;
- one human linking multiple Matrix identities without automatic equivalence;
- per-Site authorization independent of Matrix identity.

Channel purpose is explicit:

- Grove collaboration Room;
- bus projection;
- RPC/control transport lane;
- notification channel.

Typed RPC and bus events transported through Matrix never become chat bubbles merely because Matrix carried them.

---

## 8. Agents, Runtimes, models, and hosts

### 8.1 Universal Agent primitive

An Agent composes:

- durable principal;
- sponsor/scope;
- role/charter;
- lifecycle;
- Task authority;
- Room presence/speech policy;
- capabilities/tools;
- context and memory scope;
- model profile;
- placement profile;
- supervision and verification;
- budgets and limits;
- provenance.

Librarian, researcher, reviewer, builder, and coordinator are roles, not hard-coded Agent classes.

### 8.2 Private UI agents

General, Personal Librarian, graphing, and other UI assistants are private user-scoped by default.

They:

- have separate Agent identities;
- receive minimum-sufficient context;
- work under the user's private Task branch;
- do not become Room participants by being opened from a Room;
- publish by explicit snapshot;
- cannot expose private context through shared operations.

### 8.3 Agent and Runtime lifecycle

Agent states:

- Active/durable identity;
- Dormant: no Runtime, may wake;
- Suspended: reversible loss of acting authority;
- Retired: permanent end of future acting authority;
- Deleted/erased: separate privacy/legal operation.

Runtime states are independent.

One Agent normally has one active Runtime. The Runtime must hold an exclusive lease with a monotonically increasing generation. Stale Runtimes cannot speak, mutate Tasks, write memory, or use Agent-scoped capabilities.

Grove guarantees semantic Agent continuity, not exact process or model-session resume.

### 8.4 Dormancy

Automatic dormancy is the default.

A Runtime remains active while it has active work, a Room presence lease, unfinished tool activity, or an explicit keep-warm policy. Otherwise it checkpoints and stops after its profile's idle window.

Always-on is an explicit profile, not the meaning of “durable Agent.”

### 8.5 Model resolution

Agents have default model profiles. The concrete model/provider is resolved per Task under:

- capability and context needs;
- privacy/locality;
- provider availability;
- host capabilities;
- cost/budget;
- user and Room policy;
- reproducibility locks;
- fallback policy.

The resolved model and policy basis are recorded on the Attempt.

### 8.6 Hosts

Every Grove Site includes local execution capacity by default. Additional machines enroll using the same host implementation.

Enrollment proves identity and assigns a revocable host profile; it does not grant unrestricted execution.

Hosts advertise hardware, tools, models, locality, availability, and constraints. Scheduling uses those facts plus policy. Capability advertisement is descriptive, not authorization.

The box-agent/executor:

- receives authorized Task delivery;
- runs bounded worker processes;
- maintains durable pending work;
- enforces deadlines and hard ceilings;
- emits signed/attributable results;
- reports capacity and health;
- survives restart without silently losing accepted work.

---

## 9. System architecture

### 9.1 Current implementation baseline

The current authoritative source is `console-monorepo-current-daca287a`.

Already true:

- one full-stack SvelteKit console;
- Effect-based domain services;
- Remote Functions, REST/OpenAPI, MCP, and WebSockets over one domain layer;
- Postgres with hardened roles and RLS;
- `library_items`, `library_item_revisions`, `library_links`, curation, and version fields;
- Task is an allowed Library kind;
- a Work surface that combines legacy Task reads with Library items;
- ordered events/bus, attention, assistant, semantic query, command, and audit infrastructure;
- Rust manager, dispatcher, control-plane, box-agent, and Courier components;
- lease/fence/idempotency and durable-host-work patterns.

Not yet true:

- Library Task module as the sole Task writer;
- global stable IDs replacing legacy numeric-only task identity;
- full Task/Attempt/Claim/plan schema;
- signed canonical object Versions;
- Room authority and first-party participant UX;
- integrated planning/grilling workflow;
- Project knowledge contribution loop;
- unified Agent identity/Runtime lease model;
- complete Site installer/release orchestration;
- federation/A2A boundary adapters.

### 9.2 Target Grove Site

```text
Grove Site release
├── SvelteKit + Effect application
│   ├── participant UI and Admin
│   ├── Library object/version/link services
│   ├── Task/Attempt/Claim authority module
│   ├── Room authority
│   ├── identity/authz
│   ├── query/search/Librarians
│   ├── REST/OpenAPI/MCP/Remote Functions
│   └── bus/WebSocket projection
├── Manager
├── Dispatcher
├── Control-plane
├── local box-agent/host executor
├── Matrix homeserver and channel adapters
├── Courier/relay where needed
├── Postgres/Timescale/vector extensions
└── supervised migration, backup, health, and update processes

Additional machine
└── same enrolled Grove host implementation
```

Internal parts may remain separate Rust and Node processes for privilege, language, and fault-isolation reasons. They share one release manifest and operational lifecycle.

### 9.3 Authority matrix

| Fact                                                                         | Sole authority                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Object identity, Versions, typed links, citations                            | Library core                                                        |
| Task plan, status, dependencies, Attempts, Claims, completion                | Library Task module                                                 |
| Grove Room lifecycle, authorized member set, history policy, presence grants | Room module                                                         |
| Agent durable identity and lifecycle                                         | Agent identity module                                               |
| Runtime process/session and exclusive Runtime lease                          | Manager                                                             |
| Delivery/card lifecycle                                                      | Dispatcher                                                          |
| Site policy, eligibility, budget, capacity governance                        | Control-plane                                                       |
| Host-local process execution and capacity                                    | Box-agent                                                           |
| Matrix room membership enforcement and event/crypto transport                | Matrix/channel implementation                                       |
| Operator/participant presentation                                            | SvelteKit UI, never authority by itself                             |
| Bus events and projections                                                   | Event producers + bus/projector; not domain truth                   |
| Artifact bytes                                                               | Artifact store or external source; Library pins digest and metadata |
| Code branch/commit/PR/merge state                                            | Git provider; Library links exact immutable references              |

### 9.4 Repository rules

Retain the monorepo's three-tier rule:

- `apps/*`: deployable or separately executable internal components;
- `packages/*`: neutral shared contracts/libraries;
- `tools/*`: repository-internal tooling.

Apps do not import apps. Existing dispatcher types imported by box-agent/control-plane must move to a neutral fleet protocol package/crate.

Unrelated PetalNet applications remain outside Grove's product release even if they share the monorepo.

### 9.5 Data substrate

Use Postgres as the authoritative Grove database. Do not write a custom graph database.

Extend the current Library schema rather than replacing it blindly:

- stable globally unique object IDs;
- immutable Version rows with canonical hashes/signatures;
- current-head references;
- typed object facets;
- typed links with validity/version semantics;
- Task/Attempt/Claim tables or facets inside the Library authority;
- outbox/inbox and idempotency ledgers;
- RLS/ReBAC enforcement;
- search indexes;
- audit and verification material.

Timescale remains appropriate for high-volume operational events. Operational events are not the universal object history.

### 9.6 Command and event boundary

All human UI actions and agent tools call the same named command plane.

Commands:

- authenticate and authorize;
- carry idempotency keys;
- validate expected Version/fence;
- mutate one authority transactionally;
- append an outbox event;
- return the accepted Version/receipt.

The bus announces that something changed. Consumers read authoritative state. The bus never becomes a competing data store.

### 9.7 Transport

- Matrix is never-dark collaboration/RPC fallback.
- Doorman or equivalent authenticated streaming is an optional fast path.
- Both carry typed envelopes and idempotency IDs.
- MCP is the official internal agent tool boundary.
- A2A may be exposed through a gateway/facade at the system boundary.
- No external protocol owns Grove Tasks, Versions, permissions, or memory.

### 9.8 Federation

First build reserves global IDs, Site identity, issuer/signature metadata, and exportable pinned Versions.

Later federation follows:

- scoped by Project Task by default;
- guarded Site-wide grants only when intentional;
- one home Grove Site per federated Project;
- limited collaboration from last valid state during home-site outage;
- governance-changing actions freeze when home authority is unavailable;
- explicit auditable home-site transfer;
- recipient policy decides which external signatures, object types, and authorities to trust.

---

## 10. Migration from the current architecture

### Phase 0: preserve and prove the base

- keep `daca287a` as the current source baseline;
- quarantine secrets/runtime state;
- add architecture and contract tests before moving authority;
- create neutral fleet protocol packages;
- keep old snapshots as evidence only.

### Phase 1: Library Version foundation

- introduce global object IDs and Version IDs;
- migrate current `library_items` revisions into immutable Version semantics;
- add canonical hash/signature fields and verification;
- preserve current reads and UI;
- make pinned references resolve.

### Phase 2: absorb Task authority into Library

- define Task, Attempt, Claim, dependency, plan, completion, and verification schema;
- import/map legacy numeric Task IDs as aliases;
- build Library Task commands behind the existing command plane;
- run shadow reads and conformance tests against the legacy Task source;
- freeze legacy Task writes;
- cut over in one controlled step;
- keep a read-only compatibility adapter until consumers migrate;
- remove “Tracker” from product/domain language after cutover.

No dual writer is permitted.

### Phase 3: one vertical work slice

- Home Ask/Capture;
- Project Task creation;
- Planner-generated DAG;
- agent Claim/Attempt;
- one local host execution;
- output object Version;
- independent review and Task completion;
- Library contribution and retrieval.

The UI may be minimal during this slice, but it must use the final domain contracts.

### Phase 4: Rooms and Matrix binding

- Room objects and authority;
- anchor Task, membership/history, Steward, presence grants;
- explicit invocation Task creation;
- result projection;
- BYO Matrix client/account compatibility;
- channel-purpose isolation.

### Phase 5: full design and curation

- participant object pages;
- living Topics and Library front desk;
- full Home attention behavior;
- advanced views;
- Librarian automation and contribution quality controls.

### Phase 6: federation and external adapters

- Project federation;
- home-site transfer;
- signed object exchange;
- optional A2A gateway;
- capacity federation later.

---

## 11. First-build acceptance criteria

The first build is complete only when all statements below are true.

### Product

- A user can create a Project Task from private Ask/Capture.
- Grove can plan it into a validated acyclic Task DAG.
- Ambiguous work can enter a grilling session rather than pretending to be Ready.
- Multiple ready Tasks may fan out concurrently.
- A Task can produce a document or artifact linked to its exact Attempt.
- An independent review can accept/reject an exact output Version.
- Task completion is driven by the completion contract and verification policy.
- The accepted output is searchable and citable from another authorized Project without crossing its visibility policy.

### Task correctness

- Task, Attempt, and Claim states are distinct.
- A failed Attempt can create a new Attempt without duplicating the Task.
- Stale fences are rejected.
- Claim expiry and confirmed Runtime failure recover safely.
- Dependency cycles are rejected transactionally.
- External actions use idempotency and reconciliation.

### Version/provenance

- Every accepted object mutation produces an immutable Version.
- Version hashes verify.
- Authority signatures verify offline.
- Exact pinned citations remain resolvable after later edits.
- Review and approval bind to exact subject Versions.
- No `Record` table/object/API is introduced as a parallel provenance model.

### Architecture

- The one SvelteKit domain layer remains the UI/REST/MCP source.
- Apps do not import apps.
- Library Task module is the only Task writer after cutover.
- Postgres/RLS enforces visibility.
- UI and agent operations share the command plane.
- Bus consumers re-read authority rather than treating events as truth.
- One Grove release can install, migrate, health-check, back up, upgrade, and roll back the complete Site.

### UX/UI

- Ask/Capture begins private and shows its interpretation.
- Needs You contains only blocking human actions.
- “All caught up.” is truthful.
- Library search explains matches and permissions.
- Humans can inspect the exact Versions an Agent cited.
- AAA contrast is measured.
- Keyboard and reduced-motion paths work.
- Markdown edit/read parity is browser-diffed.
- Chrome, Safari, and Firefox pass the real build.

---

## 12. Deferred extension points

The first build does not require:

- a public blockchain;
- mandatory public Sigstore logging;
- full cross-Site federation;
- capacity federation;
- an A2A gateway;
- advanced spatial/3D UI;
- exhaustive Librarian heuristics;
- one fixed workflow engine;
- a complete consumer/family profile;
- a permanent full Agent for every user;
- separate Project Libraries;
- universal event sourcing.

These are extension points only if they preserve the invariants in this spec.

---

## 13. Final consistency rules

When implementing or reviewing Grove, reject a change if it:

- reintroduces a separate Tracker authority;
- creates a Record wrapper around data already owned by a Versioned object;
- treats an Attempt result as Task completion without verification;
- lets ordinary Room speech mutate authority;
- makes Matrix channel identity equal authorization;
- gives Room membership implicit Task/data/tool access;
- creates a second server/domain implementation beside the unified console;
- lets an app import another app's source;
- treats bus events as canonical state;
- makes local worktree state durable without a pushed checkpoint;
- signs a mutable reference instead of immutable canonical content;
- hides provenance or binds review to an unpinned living reference;
- exposes private UI-agent work through shared metadata;
- makes Project affiliation a default knowledge silo;
- requires users to navigate a giant graph or hundreds of Project containers to find information.

Grove is build-ready when implementation follows this model and leaves deferred choices behind clean interfaces rather than inventing new domain primitives.
