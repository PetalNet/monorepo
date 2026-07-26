# Grove Task DAG and execution model

**Status:** Focused implementation view  
**Normative source:** `01-GROVE-BUILD-SPEC.md`

This document defines how Grove turns intent into verifiable work. It is intentionally narrower than the master specification.

## 1. Non-negotiable model

- Work is a directed acyclic graph of Tasks.
- A Project is a Task with the `project` role, not a separate work container.
- Tasks may nest to arbitrary useful depth.
- Hierarchy and execution dependencies are separate relationships.
- Task, Attempt, Claim, and workflow run have separate lifecycles.
- A failed Attempt does not make its Task failed.
- A Task completes only when its completion contract passes.
- The Library Task module owns Task authority in the target architecture.
- There is no separate Tracker product.
- There is no Record domain object.
- Meaningful state is represented by immutable signed Versions and typed relationships.

## 2. Core objects

### Task

A durable unit of intent, coordination, and acceptance.

Required fields:

- stable Library object ID;
- current Version ID;
- title;
- objective;
- roles: `project`, `standing`, `work`, `review`, `approval`, or extensible equivalents;
- state;
- priority;
- parent relationship when nested;
- dependency relationships;
- completion contract;
- execution policy;
- visibility;
- origin and contributing Project relationships;
- creator identity and creation time;
- current assignee, if explicitly assigned;
- versioned attributes and typed relationships.

Optional fields include:

- deadline;
- risk class;
- preferred Agent, model, or host profile;
- budget;
- retry policy;
- required reviewers;
- workspace binding;
- Room anchors;
- workflow definition;
- external issue or system identifiers.

### Attempt

One bounded execution of a Task.

Required fields:

- stable Attempt ID;
- Task ID and pinned Task Version ID;
- executor identity;
- state;
- start and end time;
- Claim or Runtime lease reference when applicable;
- input Version IDs;
- output object and Version IDs;
- checkpoints;
- terminal result;
- failure classification when unsuccessful;
- signatures and attribution.

An Attempt may use one agent action, a human action, or a workflow run. It is not the Task itself.

### Claim

A time-bounded right to attempt work.

Required fields:

- stable Claim ID;
- Task ID;
- claimant;
- state;
- lease start and expiry;
- fencing token;
- renewal history;
- release or revocation reason;
- idempotency key.

Claims prevent duplicate active execution. They do not grant broader authorization.

### Workflow run

Optional orchestration inside one Attempt.

Required fields:

- workflow definition and version;
- Attempt ID;
- node and transition state;
- external side-effect idempotency keys;
- outputs;
- compensation or recovery state.

The workflow engine must not own Task truth.

## 3. Relationships

Use typed, directional relationships.

| Relationship      | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `child-of`        | subject Task belongs beneath the target parent Task                 |
| `depends-on`      | subject Task requires the target Task to satisfy its edge condition |
| `blocked-by`      | subject Task is blocked by the target object or condition           |
| `soft-depends-on` | advisory sequencing that does not determine readiness               |
| `implements`      | work realizes a plan, decision, or requirement                      |
| `reviewed-by`     | subject Version was evaluated by the target review                  |
| `approved-by`     | subject Version was authorized by the target approval               |
| `attempted-by`    | subject Task was executed by the target Attempt                     |
| `produced`        | subject Task or Attempt produced the target output                  |
| `uses`            | subject Task or Attempt pins the target input Version               |
| `discussed-in`    | subject object is associated with the target Room                   |
| `contributes-to`  | subject output adds to the target Project or Grove knowledge        |
| `supersedes`      | explicit replacement without deleting history                       |

Rules:

- hierarchy must remain acyclic;
- hard dependency edges must remain acyclic;
- hierarchy never implies a dependency unless explicitly added;
- the registry defines one stored direction and inverse display labels; writers do not store a duplicate inverse edge as separate truth;
- a parent may summarize child state but must not silently overwrite it;
- dependencies target stable objects and may pin Versions when exact content matters;
- relationship changes create new signed Versions or signed relationship objects;
- cycle checks run on every write and during reconciliation.

## 4. Lifecycles

### Task states

| State             | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `draft`           | intent exists but is not ready for planning or execution            |
| `planning`        | decomposition is underway; clarification/grilling may be active     |
| `planned`         | completion contract and graph placement exist                       |
| `ready`           | all hard readiness conditions pass                                  |
| `active`          | at least one valid Attempt is executing                             |
| `blocked`         | a known condition prevents readiness or progress                    |
| `waiting`         | progress is intentionally waiting for an allowed external condition |
| `recovery_needed` | execution state requires bounded reconciliation or recovery         |
| `review`          | execution output exists and required verification is pending        |
| `completed`       | completion contract passed                                          |
| `cancelled`       | intentionally stopped without completion                            |
| `abandoned`       | terminally left without completion under explicit policy            |

Allowed transitions are commands, not direct row edits.

Typical flow:

`draft -> planning -> planned -> ready -> active -> review -> completed`

Permitted recovery includes:

- `active -> ready` after an Attempt ends and retry is allowed;
- `active -> blocked` when a real external blocker appears;
- `active -> waiting` for an allowed external condition;
- `active -> recovery_needed` when safe continuation requires reconciliation;
- `review -> active` through a new Attempt when revision is required;
- `blocked -> ready` after the blocking condition clears;
- `waiting -> ready` after its condition clears;
- `recovery_needed -> ready`, `blocked`, or `review` after reconciliation;
- any nonterminal state to `cancelled` or policy-authorized `abandoned`, with authority and reason.

`completed` is reopened only through an explicit signed command that creates a new Task Version and records why the completion contract is no longer satisfied.

### Attempt states

| State                   | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `starting`              | executor and durable execution context are being established     |
| `running`               | executor is alive and working                                    |
| `result_submitted`      | candidate outputs were submitted for terminal Attempt evaluation |
| `succeeded`             | executor returned candidate outputs                              |
| `failed`                | execution ended unsuccessfully                                   |
| `fenced`                | execution lost current authority and stale writes are rejected   |
| `timed_out`             | the declared execution deadline elapsed                          |
| `cancelled`             | intentionally stopped                                            |
| `reconciliation_needed` | an external effect may have occurred and must be checked         |

An Attempt reaching `succeeded` advances the Task toward review; it does not complete the Task by itself.

### Claim states

| State        | Meaning                               |
| ------------ | ------------------------------------- |
| `leased`     | exclusive Claim lease is valid        |
| `released`   | claimant relinquished the lease       |
| `expired`    | lease elapsed without renewal         |
| `revoked`    | authority invalidated the lease       |
| `superseded` | a higher fence has replaced the Claim |

An offer is scheduler state, not a Claim state. Renewal extends a `leased` Claim and records a renewal event. Every mutating executor command carries the current fencing token. A stale claimant cannot publish authoritative output.

## 5. Planning and grilling

The Planner converts a Project Task into:

- a clarified objective;
- explicit completion contract;
- nested Tasks;
- hard and soft dependencies;
- reviewers or approvers;
- execution kinds;
- expected Library inputs and outputs;
- risk, budget, and escalation policy.

If information is missing, the Project remains `planning` and opens clarification/grilling.

The grilling experience:

1. asks only questions that materially change the plan;
2. groups related questions;
3. explains why the answer matters;
4. proposes a default where one is safe;
5. writes answers into a new Version of the Project or affected Task;
6. updates the graph visibly;
7. ends when the Planner can state the completion contract and dependency graph without unresolved blockers.

The Planner must not bury unresolved assumptions inside prompts.

## 6. Readiness

A Task is `ready` only when all applicable conditions pass:

- Task is planned and not completed or cancelled;
- every hard dependency is completed at an acceptable Version;
- required inputs exist and are readable;
- required approvals already due before execution are valid;
- no unresolved blocker relationship exists;
- an eligible executor and host profile exist for automated work;
- budget and policy gates pass;
- no valid exclusive Claim conflicts;
- the completion contract is syntactically and semantically evaluable.

Readiness is derived and reconciled. It is not a manually trusted boolean.

Pseudo-rule:

```text
ready(task) =
  planned(task)
  AND all(hard_dependencies_satisfied(task))
  AND all(required_inputs_available(task))
  AND all(pre_execution_gates_pass(task))
  AND no(unresolved_blockers(task))
  AND execution_policy_satisfiable(task)
  AND no(conflicting_claim(task))
```

A reason set accompanies every not-ready result. The UI shows those reasons without requiring a graph inspection.

## 7. Execution kinds

A Task can be executed by:

- an Agent;
- a human;
- a webhook or external API;
- a timer or wait condition;
- a research request through the Librarian;
- a code-building workspace;
- an independent review;
- an approval;
- a deployment;
- a composed workflow.

Execution kind affects eligibility and verification, not the Task identity.

### Agent execution

- resolve model, tools, host profile, and policy at Attempt start;
- allocate a Runtime;
- acquire an exclusive Claim with fencing;
- pin input Versions;
- checkpoint durable progress;
- publish outputs as Library objects and Versions;
- end the Runtime or return the Agent to dormancy;
- release the Claim.

### Human execution

- create an explicit assignment or offer;
- show the completion contract before action;
- accept signed evidence or output;
- preserve attribution;
- use the same review and completion logic as automated work.

### Webhook or external API

- use an idempotency key;
- sign the requested action;
- record request and response metadata without leaking secrets;
- retry only under the declared policy;
- reconcile ambiguous timeouts before repeating a side effect.

### Review and approval

Reviews and approvals are first-class Library objects with Versions. They identify:

- reviewer or approver;
- exact target object and Version;
- rubric or authority;
- outcome;
- comments or requested changes;
- time and signature.

They are not mutable checkboxes on a Task row.

## 8. North-star execution flow

1. A person enters a prompt through private Ask/Capture.
2. The private agent helps shape it and proposes a Project Task.
3. The Librarian files the resulting objects and relationships.
4. The Planner decomposes the Project into a nested Task DAG.
5. Missing decisions trigger a focused grilling session.
6. Ready branches fan out concurrently within budget and policy.
7. Agents request research through the Librarian rather than silently inventing shared context.
8. Research is stored as Library objects linked to the requesting and producing Tasks.
9. Builders create durable checkpoints and publish code, commits, patches, PRs, or other artifacts.
10. Independent review Tasks evaluate exact pinned Versions.
11. Revisions create new Attempts and new output Versions.
12. Merge, approval, delivery, or another domain-specific terminal action occurs.
13. The completion contract is evaluated.
14. The Task closes only when required evidence, review, and verification all pass.
15. Accepted outputs contribute back to Grove knowledge according to visibility and curation policy.

## 9. Completion contracts

Every executable Task has a versioned completion contract containing:

- required output kinds;
- validation checks;
- required reviews or approvals;
- acceptable evidence;
- terminal side effects, if any;
- policy for warnings;
- who or what can assert completion;
- what invalidates completion.

### Code example

A code Task may require:

- commit or patch linked to the Attempt;
- tests green;
- typecheck and lint green;
- no unresolved required review;
- PR merged into the declared target;
- resulting commit identity captured;
- artifact signatures valid.

### Research example

A research Task may require:

- source set and retrieval times;
- claims linked to citations;
- uncertainty and conflicts called out;
- output published as a versioned Library object;
- reviewer acceptance against a rubric.

### Human approval example

An approval Task may require:

- named authority;
- exact target Version;
- explicit approve or reject outcome;
- signature;
- expiry policy.

Completion is an evaluated fact with evidence, not a status button.

## 10. Failure and recovery

### Attempt failure

When an Attempt fails:

- classify the failure;
- preserve logs and checkpoints;
- release or expire its Claim;
- determine whether retry is safe;
- return the Task to `ready`, `blocked`, or `review` as appropriate;
- create a new Attempt for any retry.

Never reuse a terminal Attempt.

### Executor disappearance

Runtime liveness and Claim expiry are reconciled separately.

- stale heartbeat alone does not immediately authorize duplicate work;
- the lease must expire or be explicitly revoked;
- the next executor receives a higher fencing token;
- stale executor writes are rejected;
- durable checkpoints may seed a new Attempt.

### Ambiguous side effect

If an API call, deployment, merge, payment, or message may have succeeded:

1. mark the Attempt as requiring reconciliation;
2. query the external system by idempotency key;
3. attach discovered evidence;
4. resume or compensate;
5. do not blindly retry.

## 11. Builder workspaces and code durability

For code Tasks:

- create one disposable worktree or equivalent workspace per Attempt;
- bind it to Task, Attempt, repository, base revision, and branch;
- push an initial branch early when policy allows;
- make small durable commits;
- push checkpoints early and often;
- record commit identities as output Versions or artifact references;
- keep review against a pinned commit;
- tear down the workspace only after durable output is confirmed.

If a Runtime dies, another Runtime must be able to resume from Git and Library evidence without reconstructing a vanished local state.

## 12. Scheduling

The scheduler:

- selects only `ready` Tasks;
- respects hard dependencies, Claims, budgets, permissions, and host profiles;
- may fan out independent branches;
- applies per-Site, per-Project, per-Agent, and per-provider concurrency limits;
- avoids starvation with explicit priority and age policy;
- records why each Task was selected or skipped;
- issues idempotent start commands;
- relies on reconciliation rather than optimistic in-memory state.

Critical path is a useful view, not an authority.

## 13. Command surface

Representative commands:

- `create_task`
- `version_task`
- `add_dependency`
- `remove_dependency`
- `set_completion_contract`
- `plan_task`
- `answer_clarification`
- `offer_claim`
- `claim_task`
- `renew_claim`
- `release_claim`
- `start_attempt`
- `checkpoint_attempt`
- `finish_attempt`
- `submit_for_review`
- `record_review`
- `record_approval`
- `evaluate_completion`
- `cancel_task`
- `reopen_task`

Every command includes:

- caller identity;
- authority context;
- idempotency key;
- expected current Version or equivalent concurrency guard;
- causal Task/Attempt/Room context when applicable.

Commands emit durable events. UI, REST/OpenAPI, Remote Functions, MCP, and internal workflows call the same command handlers.

## 14. Views

The same Task graph supports:

- Project outline;
- dependency graph;
- board grouped by state;
- ready queue;
- timeline;
- review queue;
- Attempts and evidence history;
- Admin execution lens.

No view owns hidden state.

The default Project view favors readable hierarchy and status. The full graph is available when dependency reasoning benefits from it, not imposed as the front door.

## 15. Migration from the current tracker seam

Current code contains tracker-named reads, commands, and adapters. Treat them as migration seams.

Migration order:

1. preserve current behavior with characterization tests;
2. establish stable Library object IDs and immutable Versions;
3. add Task module command and query handlers inside the Library domain;
4. make old tracker reads delegate to the Task module;
5. freeze legacy direct Task writes;
6. migrate identifiers, state, dependencies, evidence, and links;
7. compare old and new projections;
8. move every transport to the shared Task command surface;
9. remove tracker terminology and dead storage only after parity.

At no point may old and new authorities accept independent writes.

## 16. Acceptance cases

The Task DAG is ready for the first vertical slice when these pass:

- creating a Project produces a Project-role Task and signed Version;
- planning creates nested Tasks and dependencies without cycles;
- an unresolved answer visibly prevents readiness;
- independent Tasks fan out;
- two executors cannot hold a valid exclusive Claim for one Task;
- stale fencing tokens cannot publish output;
- a failed Attempt can be followed by a successful Attempt;
- Attempt success alone cannot complete a Task;
- review pins the exact target Version;
- an output can be traced to Task, Attempt, Agent or human, inputs, and signature;
- non-code webhooks are idempotent and reconcile ambiguous outcomes;
- code work survives Runtime loss through checkpoints;
- UI and MCP perform the same authoritative commands;
- no normative API or UI introduces a separate Tracker or Record object.

## 17. Rejected shortcuts

Reject implementations that:

- equate Project with a second container model;
- use nesting as an implicit dependency;
- store readiness as an unexplained boolean;
- let workflow state replace Task state;
- let Attempt failure terminally fail a Task;
- complete Tasks from UI status edits;
- model approval as an unchecked boolean;
- permit direct writes from one transport;
- retry ambiguous external side effects blindly;
- use Agent presence as proof of a valid Claim;
- hide stale state;
- fork Task authority between Library and legacy tracker tables.
