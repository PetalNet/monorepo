# Box-agent — DECISIONS log

Fable (backend-fable), 2026-07-12, branch `feat/box-agent` (stacked on
`feat/control-plane`). New node per the backend-build brief + DAG N2.3 + fleet-manager-spec
v2 §3/§8: the persistent per-machine agent that receives task-cards over the backchannel,
spawns/supervises disposable workers, advertises capacity, and emits fleet events.

## Decisions

| #   | Decision                                                                                                                                                                                         | Rationale                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA1 | New app `apps/box-agent`, path-dep on `apps/dispatcher` for envelope/card types + spool transport                                                                                                | same contract-types source of truth as control-plane (CP2)                                                                                                          |
| BA2 | Workers are plain child processes (`std::process::Command`, argv from config with `{body}`/`{task_id}`/`{card_id}` placeholders + card fields in env) — NO tmux, NO shell string                 | Windows first-class is LOCKED (OS-neutral contracts); tmux is the per-agent manager's business, not the box-agent's; argv-not-shell kills injection by construction |
| BA3 | Envelope consumption dedups on envelope `id` persisted in the box-agent's own SQLite (`seen` table), and additionally on `card_id` for task.dispatch                                             | contract D20: redials re-send the same id; receivers MUST de-duplicate — and crash-replayed cards carry the same card_id                                            |
| BA4 | Slot accounting: `free_slots = max_workers − running`; deferred cards queue locally (FIFO) when full; honored INTERRUPT cards bypass the slot cap and spawn immediately                          | the interrupt classes exist precisely because they must not wait behind queued work; the cap protects the box from bulk work, not from Parker                       |
| BA5 | Fleet events are written per the fleet-event contract v1 (snapshot = latest event, canonical lowercase handle + '.N' host, producer never writes `offline`, `task_id` = the working card's task) | CONTRACTS §3 verbatim; the box-agent is a producer, normalization is the producer's job                                                                             |
| BA6 | Worker completion emits a `response` envelope (`in_reply_to` = the task.dispatch request id) with exit status + captured output tail into the outbox spool                                       | the dispatch request expects an answer; response correlation is the envelope contract's job — no new method needed                                                  |
| BA7 | Capacity reports (`agent.capacity` events) emit every `capacity_interval_secs` AND immediately on slot change                                                                                    | the control-plane's liveness derivation needs a steady cadence; slot-change pushes make the push-router's view fresh without a tight loop                           |
| BA8 | v1 transport = spool dirs behind the same seam as dispatcher/control-plane (CP11); doorman replaces it at N1.4 integration                                                                       | one transport idiom until doorman lands                                                                                                                             |
| BA9 | Config deny_unknown_fields; required = {handle, worker_cmd, db_path, inbox_dir, outbox_dir}; handle must be canonical at boot                                                                    | manager-config convention; a bad handle would poison every downstream file/envelope                                                                                 |

## §0 compliance

Branch-only; no live services touched; tests spawn disposable child processes
(`sh -c` equivalents via argv) and temp dirs/DBs only; build caps respected.
