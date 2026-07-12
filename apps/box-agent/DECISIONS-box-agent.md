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

## Review round (2026-07-12): codex + adversarial findings, all fixed

The reviews converged on one root cause and a set of worker-robustness gaps.

Root cause (codex P1 ×3 / adversarial critical #1+#2): the box-agent deduped and
consumed work BEFORE it was durably accepted, so a crash, a full slot queue, or a failed
spawn lost the card silently. Fixed by making a **durable `pending` table the source of
truth**: a task card is written there (idempotent on card_id — this IS the card dedup) the
moment it's accepted; the worker pool is driven FROM the table; a row is deleted only after
its response is delivered. A restart reloads pending and re-runs unfinished work. The spool
is taken to a `.working` file and committed (deleted) only after every line is durably
recorded; a crash re-reads it, and fresh envelopes appended meanwhile are folded in rather
than clobbered (adversarial #2). Verified end-to-end and by a durability integration test.

Other fixes, all tested:
| Finding | Fix |
|---|---|
| adversarial #3: interrupt cap bypass = fork-bomb | interrupts bypass the SOFT slot cap but not an absolute `hard_ceiling` |
| #6: hung worker starves a slot forever | per-worker deadline (pool budget ∧ card `expires_at`); breach → kill + timeout response |
| #4: one delivery failure killed the daemon | per-item deliver-with-retry; failures logged, loop never exits on IO |
| #5: failed cards → caller hangs | malformed task.dispatch gets an `Error` envelope (in*reply_to set); transient spawn failure just retries from pending |
| #9: `{body}` substitution corrupted the verbatim body | single-pass fill; tokens inside the body are not re-substituted |
| #10: card could choose the program / inject options | argv[0] is never substituted; FLEET_BODY env preferred |
| #12: try_wait error orphaned the child (zombie) | keep the worker running on a transient try_wait error |
| #13: promised output tail didn't exist | stdout+stderr captured to a temp file, bounded tail on the response |
| #11: seen table grew unbounded | hourly prune past a 24h retention (pending rows never pruned) |
| #14: no shutdown / inbox==outbox self-consumption | SIGTERM/SIGINT → Stop event + kill workers; config rejects inbox_dir == outbox_dir; max_workers >= 1 |
| #8: misleading env/placeholder test | replaced with tests that assert the filled placeholders and FLEET*\* env |

Residual (accepted): the O_APPEND-to-renamed-inode spool race (adversarial #7) is a narrow
window inherent to the file-spool v1 transport; the fold-in reclaim reduces it and the
doorman backchannel (N1.4) replaces the spool with an authenticated stream. The box-agent
trusts a delivered card's `interrupt_policy` (the dispatcher already enforces the honor
conditions and demotes spoofs); the hard ceiling bounds the blast radius until doorman
authenticates the sender.
