# Dispatcher / Layer-0 bus — DECISIONS log

Fable (backend-fable), 2026-07-12, branch `feat/dispatcher-core`. New node per the
backend-build brief: the Layer-0 bus that turns inbound messages (Matrix, tracker
transitions, system conditions) into task-cards, enforces the LOCKED interrupt model,
and runs the hybrid push/pull wanted board. Contracts:
`apps/manager/docs/contracts/schemas/task-card.schema.json`,
`backchannel-rpc.schema.json`, `queue-lease.schema.json`; design sources:
gallery `collab-wanted-board`, `fleet-dispatcher-review`, `fleet-manager-spec` v2,
CONTRACTS.md §4/§6.

## Ground-truth findings

- The task-card contract requires `recipient` + `task_id` on every card and
  `sender_class` stamped from the dispatcher's roster, never trusted from the sender
  (D16/D17 in the contracts log). A card claiming `principal_command` from a
  non-principal is DEMOTED to `defer`, not dropped (D27).
- The wanted-board design (collab-wanted-board) is the tasks-DB bus in pull mode with
  prefetch=1 + acks_late + a capability surfacing query (`needs ⊆ provides`,
  `priority + k·age` ordering) + CAS claim; hybrid push (targeted notify of the single
  best eligible free agent) kills the thundering herd.
- Fencing: lease expiry never proves the old worker stopped; the validated local
  pattern is `~/.claude/queue`'s `lease_generation` (incremented per (re)claim; every
  write under a lease carries it; stale fences are rejected). queue-lease.schema.json
  makes `fence` REQUIRED.
- fleet-dispatcher-review deltas adopted: wake rate-limiting (token bucket + jitter —
  thundering-herd guard), forward-verbatim (digest truncates but never paraphrases;
  full body rides the card), durable state authoritative / sessions disposable (the
  bus persists everything; wake carries no context — the recipient rehydrates from
  the tracker + card).
- The live tasks.db `agents` table is the capability registry (`capabilities` CSV =
  the lane gate, looked up server-side). tasks.db has a single writer (the tasks app)
  — the dispatcher must NOT write the live tracker DB.

## Decisions

| #    | Decision                                                                                                                                                                                                                                                          | Rationale                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DP1  | Rust app at `apps/dispatcher` in the monorepo, sync + threads (no tokio), deps: serde/serde_json/rusqlite(bundled)/uuid/chrono/rand/ureq                                                                                                                          | house style is the manager (sync, small deps); rusqlite bundled avoids host sqlite drift; ureq is already the lab HTTP client                                                                      |
| DP2  | The card store is the dispatcher's OWN SQLite DB (WAL, busy_timeout), never the live tasks.db; tracker access is behind a `Tracker` trait (SQLite impl used against temp DBs in tests; filing tasks in the live tracker is cutover wiring)                        | tasks.db has a single writer by design; the bus needs card-lifecycle fields (state, fence, reaps, reply_to) the tracker doesn't carry; TASKS_DB_PATH-style temp DBs keep tests off live data       |
| DP3  | Backchannel-rpc envelope serde types are defined in this crate (`envelope.rs`) with conformance tests                                                                                                                                                             | the canonical Rust envelope crate lands with N1.4 in the doorman repo; a cross-repo dependency doesn't exist yet — the types are small, and consolidation is a mechanical follow-up                |
| DP4  | Fence = `lease_generation` per the validated queue prototype; claim/renew/complete/deliver are all single guarded UPDATEs carrying (worker, fence); reap increments the fence                                                                                     | exactly-once effect under reap+reclaim; SQLite single-statement atomicity gives CAS for free                                                                                                       |
| DP5  | Surfacing score = `(3 - priority) + k·age_minutes` (k configurable, default 0.05), DESC; `needs ⊆ provides` hard gate; prefetch=1                                                                                                                                 | contract priority is 0=highest; aging prevents starvation (gap #5); one card per claim prevents hoarding                                                                                           |
| DP6  | Board card `recipient` is nullable while POSTED (open pool work); the task-card JSON emitted at delivery always carries the resolved recipient                                                                                                                    | the schema requires recipient on the card an AGENT receives; pool cards don't have one until routed/claimed — resolving at the delivery boundary satisfies the contract without a fake placeholder |
| DP7  | Interrupt enforcement: `safety` always honored; `principal_command` honored iff roster says sender is a principal; `task_clarification` honored iff card.task_id == recipient's active lease (Tracker lookup); everything else → `defer`. Demote, never drop      | LOCKED interrupt model (D17) + demotion (D27) verbatim                                                                                                                                             |
| DP8  | Glitchtip via a minimal DSN store-API client over ureq (panic hook + explicit capture), enabled by optional `glitchtip_dsn` config                                                                                                                                | "Glitchtip on new services" is a standing rule; the sentry crate drags tokio/reqwest — against the small-deps budget                                                                               |
| DP9  | Runtime v1 I/O: ingest = JSONL spool dir (one InboundMessage per line, files consumed atomically); delivery = `CardTransport` trait with SpoolTransport (per-recipient outbox JSONL) + InProc test transport; doorman RPC transport arrives with N1.4 integration | mirrors the proven drain-hook spool pattern; gives a real runnable daemon that disposable test agents can exercise today without any live service                                                  |
| DP10 | Wake notifications go through a token bucket (default 2 wakes/s burst 5) with full jitter                                                                                                                                                                         | dispatcher-review §5: wake stampede is the classic thundering herd; token bucket + jitter is the standard guard                                                                                    |
| DP11 | Digest: per recipient, deferred cards grouped by thread, ordered by surfacing score, capped at `digest_max_items`; bodies truncated at 200 chars with an explicit `…` marker and the card_id for retrieval                                                        | compact inbox digest per CONTRACTS §4; truncation is not paraphrase — the full verbatim body stays on the card                                                                                     |
| DP12 | Config: serde `deny_unknown_fields`, required = {db_path}; everything else defaulted; `schema_version` optional const 1                                                                                                                                           | manager-config convention: harness-critical processes fail loudly on typos                                                                                                                         |
| DP13 | Dead-letter after `max_reaps` (default 3) consecutive reaps; parked cards (no eligible agent) are re-surfaced by a capacity-change event (`agent.capacity` ingest) or the reap tick, never hot-polled                                                             | collab-wanted-board lifecycle + Nomad blocked-evals pattern                                                                                                                                        |

## §0 compliance

Own monorepo clone under /home/docker/backend-fable; no live service, config, or DB
touched; tests use temp dirs/DBs only; build caps CARGO_BUILD_JOBS=2 + nice.
