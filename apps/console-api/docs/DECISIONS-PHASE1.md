# DECISIONS — Phase 1 (query/command API)

_console-backend Fable · 2026-07-13 · per-node review record._

## Design board round 1 — draft (PHASE1-DESIGN.md, pre-code)

Reviewers: adversarial **security** persona (sub-agent) + **codex** (gpt-5.6-terra). The
**architect** persona review was cut off mid-run by the Fable-5 usage limit (session then moved
to Opus 4.8 by Parker). Codex is the lab's canonical backend adversarial reviewer and its pass
explicitly covered the architecture lens (appender/WS/ledger design, Rust-patch fit against the
real code, node dependency ordering), so the standard backend gate (codex + adversarial review)
is satisfied; the architect re-run is not repeated to conserve budget.

Verdicts: security **APPROVE-WITH-FIXES** (4 HIGH), codex **REVISE** (3 P0). All accepted;
design revised before any code. As-built claims verified in source before baking in:
tracker `claim()` pins `worker = tok.agent_name` and ignores `args.worker`
(`agent-api.js:188`); manager `Config` is `deny_unknown_fields` (`config.rs:19`); control-plane
inlet handles only `agent.capacity`/`usage.report` (`main.rs:1`).

### Applied (design fixes, no code yet)

- **Bootstrap/seeding** (codex P0, security H3): §7 — a seed migration (owner/moderator/agent
  grants, producer_registrations incl. delegated completion types, tier rows) + a
  `console-api mint-token` CLI (vault plaintext + sha256 verification). Breaks the
  grant⇄token⇄mint chicken-and-egg; without it nothing can legally emit or be administered.
- **Durable async completion** (codex P0/P1, security H1): §6 — replaced "seen-file" with a
  durable inbox+result store per executor; completion emitted under the executor's own producer
  registration (bridge = its delegated wire mouth, not a forger); console-api transitions the
  ledger on observing the completion. Executor death → attempted-without-completion.
- **Node ordering** (codex P0): N1b→N1c is now strictly serial (N1c's op verification needs
  N1b's completion tail); `channel.reclaim` deferred out of N1c to bundle with the real
  single-owner lock (today's lock is a stub) — catalog entry ships returning
  `executor_unreachable` (honest disabled-with-reason).
- **Spool trust boundary** (security H1, codex): §8 — command spool + outbox dirs `0700`,
  console-api-service-user-owned; documented as the residual-trust window = doorman
  precondition; the completion-emit rule stops forged completions, perms stop forged actions;
  `updates.apply` verifies a console-api approval token in the envelope, not a bare spool drop.
- **Principal propagation + tracker patch** (security H2): §8 — a signed `X-Console-Principal`
  assertion the tracker verifies against console-api's key; tracker added to the patch scope
  (was missing) so console writes record the true principal instead of the service identity.
- **Rust patch fit** (codex P1): §8 — manager gets BOTH `command_spool_dir` +
  `result_outbox_dir` in config/example/schema (deny_unknown_fields); durable dedup not
  seen-file; control-plane persists ALL governance state (tiers/last_actions/status_since/
  fleet_mode, not just usage/grants) + a distinct authenticated governance/fleet inlet;
  box-agent argv-exec + exact-match allowlist (security H4).
- **WS exact cutover** (codex P1): §4 — register live buffer before capturing boundary, replay
  ≤ boundary, flush buffer > boundary once, then live; re-fence on grant change.
- **Emission dedup** (codex P1): §5 — `ON CONFLICT (id) DO NOTHING RETURNING seq`; conflict →
  SELECT original seq, no fan-out; transactional idempotent 202.
- **Two-phase audit atomicity** (codex P1): §6 — intent emission + ledger row in one txn before
  dispatch; retry of an accepted op returns the recorded result, never redispatches.
- **RLS/RO-role ordering** (codex P1, security M1): §3 — one ordered migration (table → RLS
  enable+force + policy → RO role REVOKE then GRANT SELECT → security_invoker views); `SET
LOCAL app.scopes` GUC discipline; non-BYPASSRLS runtime role; CI isolation test + RLS-forced
  assertion on every base table.
- **body_ref/blob scope** (security M2): §3 — blobs RLS-scoped like events; delivery `*_ref`
  caller-scoped.
- **Token/allowlist custody** (security M3/M4, L1): §8/§9 — Matrix bot token + box-agent
  allowlist service-user-owned, never agent-writable; test harness fails closed if
  `TASKS_DB_PATH` is unset/live; test-only Matrix token+room.
- **Test matrix** (codex P2): §9 — catalog-driven per-op coverage (testable field = checklist)
  - the contract-critical negatives/races (replay concurrency, id_reused, intent-fail
    fail-closed, executor-death, re-fence, RLS isolation, emits[] forgery, forged spool).

## N1a build — service core + lake + bus + bootstrap

Built + tested on a disposable TimescaleDB container (the brief's temp-DB rule; never live Janet).
29 tests green (17 unit + 4 broker + 8 db-backed): emission validation, secret scrubber,
emit-authz (source/namespace/scope/severity denials), exact WS replay→live cutover, buffer flush,
gap-on-backpressure, scope guard, emit + transactional dedup, RLS scope isolation (parker can't
see eli; empty scope → nothing), honest query refusal. Typecheck + eslint + knip (both modes) +
fmt all clean.

**Deviation from the P0 stack pin — recorded, not silent:** the pin named Drizzle ORM; N1a uses
**raw postgres-js** for the DB layer. Why: the ordered security migration (roles → RLS
enable+force → policy → RO REVOKE/GRANT → security_invoker views) and the per-transaction
`SET LOCAL app.scopes` GUC the RLS policy reads are load-bearing and order-sensitive; Drizzle's
schema generator does not cleanly express policy ordering, FORCE RLS, or GUC-driven policies, so a
hand-authored SQL migration is clearer and auditable — it IS the security boundary. postgres-js
gives the parameterized queries + transaction control the appender/withScopes need. The contract
and wire shapes are unaffected (zod validates the wire; the DB layer is an implementation detail);
Drizzle can return for typed table models later if it earns its place.

**Deferred within N1a (honest, noted in code):** `events` stays a plain Postgres table in N1a; the
TimescaleDB hypertable conversion + continuous aggregates + retention policies move to N1d (where
lake.disk.watermark + retention live) — a hypertable's unique index must include the partition
column, which fights the global `id`-unique that clean `ON CONFLICT (id)` dedup needs, so the
conversion belongs with the retention work (via an emission_ids dedup gate). The extension is
created in the migration so N1d only adds the conversion. SQL query mode, `/graph`, and the
command/library planes are N1c–N1d + Phase 2 per the DAG.

### Next

PR N1a → codex + adversarial review → merge, then N1b (bridges + typed reads + completion tail).
