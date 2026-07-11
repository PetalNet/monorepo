# Janet Fleet Harness — Shared Contracts (N0.1)

_Branch `docs/N0.1-contracts` · Fable, overnight 2026-07-09 · REVIEWABLE SPEC ONLY — no
service code, no live changes. Decisions + ground-truth findings: [DECISIONS.md](DECISIONS.md).
Machine-readable schemas: [`schemas/`](schemas/) (JSON Schema draft 2020-12)._

This is the foundation node (N0.1) of the harness-rewrite DAG: the canonical schemas every
component speaks — manager, box-agents, workers, the tasks tracker, and the doorman
backchannel — so they agree on one shape instead of drifting.

## 0. Rules that apply to every contract

1. **Versioned.** Every instance carries an integer `schema_version`. Each schema pins its
   current version with `const`, so a validator rejects wrong-version instances. Absence of
   the field means "the legacy pre-contract shape" (documented per contract below).
   - **Bump rules:** adding an optional field with a safe default = same version (consumers
     must tolerate unknown _optional_ additions where `additionalProperties` allows).
     Renaming/removing/retyping a field, changing an enum's meaning, or changing required
     fields = version bump + a migration note in this file.
2. **OS-neutral.** No contract may _require_ a POSIX-ism. tmux/pane fields are nullable;
   paths appear only inside the manager's own config (which is per-host by definition);
   hosts are labels, not addresses. Box agents run on Windows as first-class citizens.
3. **Timestamps.** New contracts use RFC 3339 UTC strings (`format: date-time`). The one
   exception is the deployed heartbeat, which keeps epoch-seconds (its consumers do
   freshness arithmetic; see D7).
4. **Identity.** Agent handles are canonical lowercase (`^[a-z0-9][a-z0-9._-]*$`); hosts use
   the canonical `.N` form for lab dot-hosts. Normalization is the **producer's** job now —
   consumer-side fixups (fleet.js's `dotN→.N`, filename-wins-over-body) exist only for v0
   compatibility.
5. **Tracker ties.** The tracker is the source of truth. Task-cards **require** `task_id`;
   fleet events and RPC calls carry it whenever the activity belongs to a task
   (spawn-from-task).
6. **Secrets.** `claim_token` is the only secret any of these contracts carry. It is minted
   server-side, authenticates lease operations, and MUST never reach a browser, a log line,
   or a task-card. Every viewer-bound projection uses `leasePublic`.

## 1. Contract catalog

| Contract        | Schema                                         | Produced by                                  | Consumed by                                                                      |
| --------------- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| Session state   | `session-state.schema.json`                    | manager (one writer per agent)               | manager (own restart); rollback manager.js                                       |
| Heartbeat       | `session-state.schema.json#/$defs/heartbeat`   | manager, every 1s tick                       | `healthcheck` subcommand; canary deploy driver; future cockpit                   |
| Channel lock    | `session-state.schema.json#/$defs/channelLock` | manager/matrix-channel (lock holder)         | healthcheck; other would-be owners (stand-down signal)                           |
| Fleet event     | `fleet-event.schema.json`                      | every agent's lifecycle hooks (all machines) | tasks cockpit (`fleet.js`), sidebar rail; future manager control plane           |
| Task card       | `task-card.schema.json`                        | Layer-0 bus/dispatcher (only)                | recipient agents (Janet, box agents)                                             |
| Queue lease     | `queue-lease.schema.json`                      | tasks tracker (single writer, atomic claim)  | workers (hold/report), dispatcher (route), cockpit (`leasePublic` only)          |
| Backchannel RPC | `backchannel-rpc.schema.json`                  | manager ↔ box agents (both directions)       | doorman edge routes it; Matrix floor carries it verbatim when doorman is blocked |
| Manager config  | `manager-config.schema.json`                   | operator / nix module (per host)             | manager at boot (deny-unknown, fail-loud)                                        |

## 2. Session state + heartbeat (manager ↔ itself, healthcheck, deploys)

**Session state** is the tiny durable file that survives manager restarts:
`{schema_version, sessionId, bootstrapped}`. `sessionId` is camelCase **on purpose** — a
rollback to manager.js keeps working (it ignores extra keys). `bootstrapped=false` means the
id was freshly minted (launch `--session-id`), `true` means resume (`--resume`); absent
defaults to true because a legacy file implies an already-running session.

**Heartbeat** is the manager's 1-second status snapshot and the healthcheck/canary gate:
process identity (`pid`, `version`), the supervisor state machine state
(`starting|running|rate_limited|waiting|crashed|stopped`), the supervised `session_id`,
pane ownership (`tmux_session`/`pane_id`, nullable on non-tmux platforms), `crash_count`,
and three epoch clocks (`started_at_epoch`, `last_sync_ok_epoch`, `updated_at_epoch`).
Healthcheck asserts: fresh (≤30s default), pid alive, state allowed, pane alive+tagged when
running, Matrix sync fresh (≤120s default, 0 = never = fail).

**Versioning note:** the deployed heartbeat writes `schema: 1`. The canonical contract is
`schema_version: 2` — the rename plus two additive fields: optional `handle` (which agent
this manager supervises — one host can run several managers) and `channel_lock`.

**Channel lock (LOCKED requirement).** The single-owner Matrix lock is load-bearing: exactly
one process may speak as the agent on its channel. The heartbeat's `channel_lock` object
makes that state observable: `state ∈ held | released | lockout`, plus `owner`,
`acquired_at_epoch`, and (for lockout diagnostics) `contender`. Semantics:

- `held` — this manager owns the channel and may send/receive.
- `released` — clean handover; nobody should be squatting.
- `lockout` — another owner was detected (the Focus-squat reboot race): this process MUST
  NOT send on the channel, and healthcheck can now see and alert on the condition instead
  of it being invisible until Janet goes silent.

## 3. Fleet event (lifecycle hooks → cockpit)

One JSON object per lifecycle hook firing (`session_start | pre_tool | post_tool | stop`).
Today it is materialized as `data/fleet/<handle>.json`, overwritten each event — **the
snapshot file is defined as "the latest event"**, so one schema covers both the push (a
future bus/RPC event) and the file. Producer-reported `status` is only
`alive | working | idle`; **`offline` is derived by the consumer** from `updated_at`
staleness (90s today) and must never be written. New in v1: `event` (which hook fired) and
`task_id` (the claimed tracker task — the explicit spawn-from-task tie; the cockpit's
`activeLeases()` join remains as the v0 fallback). Producers must emit canonical handle/host
forms (rule 0.4). `additionalProperties: true` — this is the one many-producers contract,
so consumers skip unknown fields rather than reject.

## 4. Task card (dispatcher → agent) — the interrupt model

The Layer-0 bus turns Matrix messages, tracker transitions, and system conditions into
**task cards** — the only way work reaches an agent. Core fields: `card_id` (dedup on
retry), **required `task_id`** (tracker tie; the dispatcher files a task first if the
message is new work), `sender`, dispatcher-stamped `sender_class`
(`principal | agent | system` — from the dispatcher's roster, never trusted from the
sender), `recipient`, `priority` (0–3, 0 highest, same scale as the tracker), `thread`
(replies stay joined across transports), `requires_reply`, `body` (verbatim — forward,
don't paraphrase), optional `capability` (lane gate) and viewer-safe `lease`.

**`interrupt_policy` (LOCKED).** Only three things interrupt Janet mid-task; everything
else queues into the compact inbox digest:

| Value                | Meaning                                | Honored when                                    |
| -------------------- | -------------------------------------- | ----------------------------------------------- |
| `defer` _(default)_  | queue for the digest; never interrupts | always                                          |
| `principal_command`  | direct Parker/Eli command              | `sender_class == principal`                     |
| `safety`             | a safety condition                     | always                                          |
| `task_clarification` | clarification on the ACTIVE task       | `task_id` matches the recipient's current lease |

Enforcement is the **dispatcher's** job (it stamps `sender_class` and checks the honor
conditions); the recipient may trust a delivered interrupt. A card claiming
`principal_command` from a non-principal is delivered demoted to `defer`.

## 5. Queue lease (atomic claim / lease / reap)

The tracker is the single writer; a claim is one atomic guarded UPDATE (todo→doing +
`claimed_by` + `claim_token` + `lease_expires_at`), so two workers can never win the same
task. Default lease 30 minutes (`lease_seconds: 1800`); expired leases are reaped back to
`todo` with lease fields cleared; **any** transition out of `doing` clears the lease. Only
the holder (`worker` + `claim_token`) may report (`review | blocked | done`); closes require
a reason (why-ledger); verification is `verified → done` or `rejected → todo` + lease
cleared.

**New, required: `fence`** — a per-task monotonic integer incremented on every successful
(re)claim. Lease _expiry_ never proves the old worker _stopped_; every write made under a
lease carries its fence and the store rejects stale fences, so a delayed/zombie worker
cannot commit after reap+reclaim. (Dispatcher-review §4 correction; pattern already
validated locally in the `~/.claude/queue` prototype.)

**Two projections:** the full lease (server + the winning worker only) and `leasePublic`
(no `claim_token`) for cockpit swimlanes and countdowns. Capability/lane eligibility is
resolved server-side from the agents registry — a worker cannot widen its own pool.

## 6. Backchannel RPC envelope (doorman)

One envelope for all manager↔agent RPC over doorman (wss/443 + yamux + Noise), and —
because doorman owns the fallback decision — **the identical envelope rides the Matrix
never-dark floor**. That is why the envelope is transport-agnostic by construction:
connection auth (per-agent Noise keypairs), session resume (edge slot re-attach), and warm
conn failover are transport concerns and deliberately have **no fields here** (D21).

`type ∈ request | response | event | heartbeat | error`. Requests/events require a
namespaced `method` (`task.dispatch`, `agent.status`, …); responses/errors require
`in_reply_to`. `payload` is free-form per method (each method documents its own payload
schema — out of N0.1's scope). `task_id` ties work-related calls to the tracker.

**Idempotency (required by the doorman design):** redials re-send in-flight requests, so
`id` doubles as the idempotency key — receivers de-duplicate on it, and side-effecting
handlers must tolerate the same id twice. Errors carry a stable snake_case `code`, a
`message`, and `retryable` (may the caller re-send the same id after backoff).

## 7. Manager config (deny-unknown-fields)

Exactly the shape manager-rs enforces today via serde `deny_unknown_fields`: a typo'd key
fails loudly at boot — this process is harness-critical, misconfiguration must be visible.
Required: `creds_path` (→ `$defs/matrixCreds`: `homeserver`, `access_token`, `user_id`) and
`control_room`. Everything else is optional with the documented defaults (agent name, paths
for state/heartbeat/exit-code/rate-limit-hook/model-override, tmux session/pane-tag/geometry,
`claude_bin`/`claude_args` — lab-specific flags live in config, never in code —
`path_prepend`, `kill_agent_on_shutdown`). `schema_version` is optional _for this contract
only_: the live binary rejects unknown keys, so it becomes writable with the first rewrite
release (absence = 1).

## 8. Cross-contract flows (how a unit of work moves)

```
Parker (Matrix) ──► dispatcher: files/loads tracker task ──► task-card {task_id, sender_class:principal, interrupt_policy}
                                                                  │ delivered via backchannel-rpc {type:request, method:task.dispatch, id=idempotency}
                                                                  ▼
                                              agent claims → queue-lease {worker, claim_token, fence}
                                                                  │ works; lifecycle hooks emit fleet-event {status:working, task_id}
                                                                  ▼
                                              reportTask (holder-only) → verify → done + close_reason
meanwhile: manager writes heartbeat every 1s {state, channel_lock} ──► healthcheck / canary gate
```

## 9. Explicitly out of scope for N0.1

- Per-method RPC payload schemas (each method documents its own; N2.x work).
- The agents-registry row shape (it exists in tasks SQLite; it becomes a contract when the
  dispatcher API externalizes it — N2.1).
- Doorman wire framing/handshake (transport layer; branches phase-1/phase-2).
- Any migration/cutover plan for live services.
