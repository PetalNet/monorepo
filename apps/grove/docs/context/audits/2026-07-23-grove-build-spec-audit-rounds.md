# Grove build specification — adversarial audit rounds

**Audit date:** 2026-07-23  
**Scope:** `GROVE-HANDOFF/` master specification, focused views, and current-code evidence  
**Implementation snapshot reviewed:** `daca287a`  
**Spec artifact reviewed:** workspace document set; final master SHA-256 `81d85d1036a8a11d45bd90227f14e4ecf5c108dfdf95523dac0e60c2b29dd8a8`  
**Repository note:** the Grove preparation root is a source export, not a Git worktree, so the document artifact hash identifies the reviewed final spec state.

## Audit method

The pass used these attack lenses:

1. domain consistency across master and focused documents;
2. current-code truth versus target claims;
3. authority and migration safety;
4. Task/Attempt/Claim state-machine completeness;
5. privacy and authorization boundaries;
6. signature/canonicalization implementability;
7. data and relationship integrity;
8. failure, retry, and reconciliation behavior;
9. Room/Matrix boundary correctness;
10. acceptance-criteria traceability.

The current source was inspected at:

- `sip-mega-export/console/_CURRENT-SOURCE-NOTE.md`;
- `console-monorepo-current-daca287a/docs/ARCHITECTURE.md`;
- the accepted unified SvelteKit Console ADR;
- current Library migrations/store;
- current tracker read and command adapters;
- manager/dispatcher lease, fence, and idempotency contracts.

## Round 1 findings

### 1. P0 — Personal Project output could be interpreted as automatic Grove publication

**Evidence**

The initial draft said Project-role Tasks had a default Grove contribution policy and that accepted output entered Grove, while other sections said Personal content required explicit publication. Implementing the broad wording would cross a visibility boundary and could expose private work.

**Fix**

- `01-GROVE-BUILD-SPEC.md:525-527` now distinguishes Grove-realm default contribution from realm-preserving Personal contribution.
- `01-GROVE-BUILD-SPEC.md:1201` makes cross-Project retrieval authorization-bound.
- `02-UX.md:211-220` states that Personal Project output remains Personal absent explicit action or standing policy.
- `00-READ-ME-FIRST.md:55` labels the vertical-slice contribution realm-safe.

**Verdict:** fixed.

### 2. P1 — Task, Attempt, and Claim lifecycle names drifted between master and focused DAG documents

**Evidence**

The master used `Planning`, `Waiting`, `Recovery needed`, `Starting`, `Result submitted`, `Fenced`, and `Superseded`; the first focused draft used a different, smaller set and treated Claim offer/renewal as states. Two agents could build incompatible enums and transitions.

**Fix**

- `01-GROVE-BUILD-SPEC.md:585-610` defines `Draft -> Planning -> Planned -> Ready -> Active -> Review -> Completed`, side states, terminal alternatives, and the Planned/Ready distinction.
- `01-GROVE-BUILD-SPEC.md:632-644` makes renewal an event that leaves a Claim leased.
- `04-TASK-DAG.md:147-210` mirrors the canonical Task, Attempt, and Claim states and transitions.

**Verdict:** fixed.

### 3. P1 — Relationship vocabulary mixed underscore pairs, inverse duplicates, and hyphenated canonical names

**Evidence**

The master used names such as `child-of` and `depends-on`; the focused DAG initially used `parent_of / child_of`, `blocks / blocked_by`, and other duplicate inverse pairs. This would cause schema drift, double edges, and inconsistent cycle checks.

**Fix**

- `01-GROVE-BUILD-SPEC.md:409-432` establishes hyphenated vocabulary, one canonical stored direction, and inverse display labels.
- `04-TASK-DAG.md:120-139` uses the same names and prohibits duplicate inverse truth.

**Verdict:** fixed.

### 4. P1 — Grove Room authority and Matrix transport membership were ambiguous

**Evidence**

One draft described Matrix as providing membership/history while the master assigned Room membership/history to Grove. This left unclear whether joining a Matrix room granted Grove data access.

**Fix**

- `01-GROVE-BUILD-SPEC.md:1034-1040` separates Grove authorized membership/history policy from Matrix membership enforcement/event transport.
- `05-ARCHITECTURE.md:185-205` makes the bridge reconcile Grove membership to Matrix and states that Matrix membership grants no Grove authority by itself.
- `05-ARCHITECTURE.md:219-220` separates Grove Room policy from raw Matrix conversation event history.

**Verdict:** fixed.

### 5. P1 — Signature acceptance criteria had no exact canonical envelope

**Evidence**

The first draft required content-addressed signed Versions and offline verification but allowed several envelope shapes without choosing canonical JSON, digest, signature algorithm, payload type, timestamp representation, or set ordering. Independent Node and Rust implementations could produce different Version IDs.

**Fix**

- `01-GROVE-BUILD-SPEC.md:225-247` defines Grove Version Envelope v1: RFC 8785/JCS, SHA-256, Ed25519, DSSE v1, payload type, parent ordering, text normalization, number/timestamp handling, and key-history requirements.
- `05-ARCHITECTURE.md:478-491` repeats the implementation constraints and requires cross-language golden vectors.

**Verdict:** fixed.

### 6. P1 — Current Task-shaped Library items could be mistaken for completed Task-authority migration

**Evidence**

Current `dashboard/store.ts` has `kind === "task"` behavior and mutable Library status Versions, but the accepted ADR and live adapters still name the single-writer SQLite tracker as Task authority. An implementation agent could add new Task writes beside the old writer and create split-brain state.

**Fix**

- `CURRENT-IMPLEMENTATION-EVIDENCE.md:102-116` documents the apparent overlap and why it is not authority migration.
- `CURRENT-IMPLEMENTATION-EVIDENCE.md:200-210` makes single-cutover proof explicit.
- `05-ARCHITECTURE.md` requires legacy write inventory, compatibility projection, write freeze, and one cutover with no dual-writer interval.

**Verdict:** fixed at specification/migration level; implementation gate remains mandatory.

### 7. P2 — “Workspace belongs to Task” conflicted with “one worktree per Attempt”

**Evidence**

The statements could lead one implementer to reuse a physical worktree across failed Runtimes and another to abandon Task-level branch continuity.

**Fix**

- `01-GROVE-BUILD-SPEC.md:726` assigns the logical branch/checkpoint lineage to the Task and the disposable physical worktree to an Attempt.
- `04-TASK-DAG.md:431-440` preserves one disposable worktree per Attempt and durable Git continuation.

**Verdict:** fixed.

## Round 2 verification

Checks performed after remediation:

- all local Markdown links resolve;
- every surfaced document names `01-GROVE-BUILD-SPEC.md` as the normative source;
- target-language uses of Tracker are negative constraints or migration references;
- target-language uses of Record are negative constraints or recordicide explanations;
- Project is consistently a Task role;
- Task, Attempt, Claim, workflow run, Agent, and Runtime remain distinct;
- focused Task lifecycle names now match the master;
- relationship vocabulary matches across master and Task DAG view;
- Personal-to-Grove movement always requires authorization or standing policy;
- Matrix identity/membership is never equated with Grove authorization;
- current implementation features are separated from target features;
- no app-to-app dependency or second Console is proposed;
- no workflow engine is made Task authority;
- external effects require idempotency and reconciliation;
- review and approval pin exact Versions;
- accepted code completion requires checks, review, and merge;
- first-build acceptance covers product, Task correctness, provenance, architecture, and UI.

No open P0 or P1 document-consistency finding remains.

## Accepted P2 watch items

### A. Physical schema names remain illustrative

`05-ARCHITECTURE.md` defines logical structures but requires reconciliation with the current migration naming. This is acceptable because logical ownership and no-dual-writer constraints are normative. The migration ADR must choose final table names before code lands.

### B. Workflow engine selection is deferred

Effect Workflow, an embedded PostgreSQL executor, or another engine may implement an Attempt. This does not block the first build because the public Task/Attempt/Claim semantics, restart behavior, idempotency, and inspection requirements are fixed.

### C. Public transparency is deferred

Local DSSE/Ed25519 verification is fixed. Public Sigstore/Rekor publication remains optional and must not leak private payloads.

### D. Matrix deployment details are later-phase

Room authority and transport contracts are fixed, but exact homeserver/bridge rollout is not required for the first Task vertical slice.

## Final verdict

**GO for implementation of the specified first vertical slice.**

This is not a claim that the current code already implements the target. It means the handoff is internally consistent, grounded in the current architecture, explicit about the authority migration, and guarded against the highest-risk interpretations.
