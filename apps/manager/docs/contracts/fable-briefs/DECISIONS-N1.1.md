# N1.1 Manager Supervisor Core — DECISIONS log

Fable, 2026-07-10, branch `feat/N1.1-manager-core` (from tip of `feat/N-phase1-briefs`).
MERGE/HARDEN node: manager-rs stays a faithful port; this branch makes it speak the N0.1
contracts and covers the state machine with tests. REVIEWABLE-ONLY — no live config, no
service restarts, no writes under `~/.claude/shared/`, local commits only, no push, no PR.

## Phase 1 — Ground-truth findings

### Heartbeat today (`state.rs::Heartbeat`, written by `supervisor.rs::write_heartbeat`)

- Key `schema: 1` (u32), plus `version`, `pid`, `state`, `session_id`, `tmux_session`
  (non-nullable String today), `pane_id` (Option), `io_ok` (hardcoded `true`), `crash_count`,
  `started_at_epoch`/`last_sync_ok_epoch`/`updated_at_epoch` (u64 secs, 0=never).
- Written every 1s tick AND once more during graceful shutdown (state `stopped`).
- Consumer: `health.rs::run` — parses via plain serde (no deny_unknown), asserts fresh ≤30s,
  pid alive, state allowed (default `running`), pane alive+tagged when `running`, sync fresh
  ≤120s (`0 disables`; `last_sync_ok_epoch == 0` ⇒ fail). Uses `hb.tmux_session` +
  `cfg.pane_tag` to re-check the pane.
- Canary contract (RUNBOOK/FABLE-SPEC): healthcheck exit code is the gate; shape asserts are
  exactly the above — nothing else parses the heartbeat on this host.

### Contract target (N0.1 `session-state.schema.json#/$defs/heartbeat`, v2)

- `schema_version` const 2 (rename of `schema`); required set = {schema_version, version,
  pid, state, session_id, io_ok, crash_count, started_at_epoch, last_sync_ok_epoch,
  updated_at_epoch}. `additionalProperties: false`.
- New OPTIONAL `handle` (pattern `^[a-z0-9][a-z0-9._-]*$`) and `channel_lock`
  ($defs/channelLock: required {state ∈ held|released|lockout}, optional/nullable `owner`,
  `acquired_at_epoch` (0=unknown), `contender`).
- `tmux_session`/`pane_id` are `string|null` — consumers MUST NOT require them (OS-neutral).

### Session state today (`state.rs::SessionState`)

- `{"sessionId": uuid, "bootstrapped": bool}`; camelCase `sessionId` LOCKED (manager.js
  rollback); absent `bootstrapped` defaults true; atomic write mode 0600. No version field.
- Contract v1: optional `schema_version` const 1, absence = 1, "producers MUST write it".

### Config today (`config.rs::RawConfig`)

- `deny_unknown_fields`; required {creds_path, control_room}; 16 optional fields with
  defaults exactly matching `manager-config.schema.json`. No `schema_version` field yet —
  the live binary would reject it (schema note says it becomes writable with this rewrite).
- `config.example.json` parses against today's RawConfig (all keys known, no version key).

### State machine (`supervisor.rs`)

- `handle_exit`: Stopped ⇒ early-return + clears leaked `rate_limit_reset`; rate-limit path
  ⇒ wait = max(reset−now, 60s) + 15s grace, clears crash counters, state Waiting, pending
  RateLimit resume; crash path ⇒ uptime > 60s resets counters, count > 10 (MAX_CRASHES) ⇒
  Stopped + "send 'start'", else backoff 5s doubling capped 30min, state Crashed.
- `check_rate_limit_hook_file`: consumes (reads+deletes) hook file; `resetAt` accepts
  RFC3339 string, epoch secs, epoch millis (string or number; ≥10^12 ⇒ millis heuristic via
  `epoch_to_utc`); unparseable ⇒ WARN, treated as plain crash.
- Testability: `Supervisor` fields are private but a `#[cfg(test)] mod` inside supervisor.rs
  has module access; `Config` has all-pub fields (constructible in tests); `Tmux::new` runs
  no tmux command; `handle_exit` itself never touches tmux or the network (sends go to an
  mpsc Sender we can hold the Receiver for). `started_at` back-dating via
  `Instant::checked_sub` covers quick-vs-long crash without any clock refactor.
- No tests exist anywhere in the crate today (`grep cfg(test)` — zero hits).

### Phase 1 decisions

| #   | Decision                                                                                                                                      | Rationale                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | No dual-key transition window: write `schema_version: 2` only; health.rs updated in the same commit (brief default for N0.1 open question #3) | manager + healthcheck are one binary shipping as one unit; a v1-tolerant _reader_ covers the only real skew (new healthcheck binary vs old running manager) |
| N2  | health.rs v1 tolerance via `#[serde(alias = "schema")]` on `schema_version` + a deprecation note when the parsed version is 1                 | one struct, no second parse path; a v1 file (`schema: 1`) still deserializes and the note makes the legacy shape visible in healthcheck output              |
| N3  | `channel_lock` is a STUB: constant `{state: "held", acquired_at_epoch: 0}` until N1.3/N2.2 wires the real matrix-channel lock                 | brief mandates the stub; `held` is the only truthful value for today's single-manager deploy; 0 = unknown per schema                                        |
| N4  | `handle` = `agent_name` lowercased at heartbeat-write time                                                                                    | contract pattern requires lowercase; rule 0.4 makes normalization the producer's job; config keeps accepting any display name                               |
| N5  | Heartbeat `tmux_session` becomes `Option<String>` (this manager always writes `Some`)                                                         | contract says string\|null and consumers MUST NOT require it; makes the healthcheck reader OS-neutral now, zero behavior change on this host                |
| N6  | Optional heartbeat fields serialize with `skip_serializing_if = "Option::is_none"` (handle/channel_lock; lock's owner/contender)              | `additionalProperties: false` + optional = omit-when-absent is the cleanest conforming shape; avoids emitting nulls the schema only sometimes allows        |
| N7  | Refactor limited to extracting `parse_reset_at(&Value) -> Option<DateTime<Utc>>` from `check_rate_limit_hook_file`                            | the parse matrix (RFC3339/secs/millis/garbage) becomes a pure-function table test; file-consumption semantics still get their own test; no redesign         |
| N8  | Tests write scratch files under `std::env::temp_dir()/agent-manager-test-<pid>-…`, never `~/.claude/shared/`                                  | REVIEWABLE-ONLY rule: the live shared state dir is untouchable, and tests must not depend on host layout                                                    |
| N9  | `SessionState` gains `schema_version: u32` defaulting to 1 and always serialized                                                              | contract: absence = 1 on read, producers MUST write it; manager.js rollback ignores extra keys so writing it is rollback-safe                               |
| N10 | `RawConfig` gains `schema_version: Option<u32>`, accepted and ignored (allow(dead_code))                                                      | brief deliverable 2 verbatim: accept const-1 key, no behavior; validation of the value stays with the external schema validator                             |

## Phase 2 — Heartbeat v2 + healthcheck dual-read (implemented)

- `state.rs`: `Heartbeat.schema_version` (const 2 via `HEARTBEAT_SCHEMA_VERSION`, serde
  `alias = "schema"` for v1 reads), optional `handle` + `channel_lock` (omitted when None),
  `tmux_session` now `Option<String>`; new `ChannelLock`/`ChannelLockState` with
  `stub_held()`. Supervisor writes handle = lowercased `agent_name`, lock stub, and
  `Some(tmux_session)` — same commit, one binary (N1).
- `health.rs`: deprecation note on a parsed v1 shape; note (not failure) on any other
  unexpected version — the gate stays the five behavioral asserts, shape-version skew is
  made visible but doesn't flip a healthy deploy red (rationale: canary gate must not fail
  on the exact transition it exists to manage). `tmux_session: null` + state=running now
  skips the pane assert with a note (contract: consumers must not require tmux fields).
- Tests (state.rs): v2 contract shape (no `schema` key, omit-when-absent optionals), v2
  round-trip, legacy v1 parse, null tmux fields parse. `cargo check` clean; 4/4 green.

## Phase 3 — Config + session-state conformance (implemented)

- `config.rs`: `RawConfig.schema_version: Option<u32>` — accepted, ignored (N10). Tests pin
  the schema semantics _as serde behavior_: example config parses, required set is exactly
  {creds_path, control_room} (each missing key errors by name), a typo'd key fails with
  "unknown field", schema_version accepted. In-process JSON-Schema validation deliberately
  NOT added (brief: conformance = serde behavior tests; no new deps).
- `state.rs`: `SessionState.schema_version` default 1, always serialized (N9);
  `SESSION_STATE_SCHEMA_VERSION` const. Tests: legacy no-version/no-bootstrapped file
  defaults (1 / true), fresh save→disk shape (schema_version written, `sessionId` camelCase,
  bootstrapped=false)→load round-trip, and a from-disk legacy-file load. Test scratch files
  live under the OS temp dir, never `~/.claude/shared/` (N8). 11/11 tests green.

## Phase 4 — State-machine tests (implemented)

- Refactor stayed at the N7 minimum: `parse_reset_at(&Value)` extracted from
  `check_rate_limit_hook_file`; nothing else moved. No supervisor redesign, no trait mocks —
  `handle_exit`/`check_rate_limit_hook_file` already touch neither tmux nor the network, so
  the tests build a real Supervisor on a throwaway Config (all-pub fields) with the Matrix
  mpsc receiver held for message asserts (same-module `#[cfg(test)]` gives field access).
- Coverage: rate-limit exit (wait ≈ reset+15s grace, counters cleared, RateLimit resume,
  Matrix message), past-reset 60s floor, 10-crash doubling table [5,10,…,1280,1800] with
  cap + crash-11 MAX_CRASHES stop + message transcript, long-uptime counter reset,
  spawn-failure (started_at=None) counting as quick crash, Stopped-state early-return
  clearing a leaked rate-limit reset, `parse_reset_at` 15-case table (RFC3339 ± offset,
  secs/millis × string/number, the 10^12 heuristic boundary, garbage), hook-file
  consume-on-read semantics (valid, garbage×3, missing).
- Timing asserts use ±1s windows on `pending_resume.at` (via `saturating_duration_since`)
  rather than clock mocks — the delays under test are ≥5s, so the windows are safe on any
  loaded box. Uptime back-dating via `Instant::checked_sub` (no clock refactor needed).
- 21/21 tests green.

## DIRECTIVE UPDATE (2026-07-10, mid-run) — re-plan

Parker + Eli's `DIRECTIVE-N1.1-UPDATE.md` supersedes the branch-only/no-merge rules:
target is now the monorepo (`/home/docker/Monorepo`, matrix-bot migration precedent),
tests must pass in an isolated container via a build→test→fix loop, Sol (GPT-5.6 via
`/usr/bin/codex`) must review before merge, then self-merge LOCALLY (GitHub unreachable —
push stays pending for a human). Build-budget caps + never-touch-live rules still apply.
Phases 1–4 above are unchanged and committed; they are the migration source.

### Migration ground truth (read before planning)

- Precedent (docs/MIGRATION.md + `migrate-matrix-bot` branch): clone source → `git mv` into
  `apps/<dest>/` → commit → add clone as remote → `merge --allow-unrelated-histories` →
  flatten nesting → cleanup commits in order (cruft drop; oxfmt reformat as its OWN commit +
  `.git-blame-ignore-revs`; lint/check fixes separate) → record in the Migrated list.
- Rust-app conventions (matrix-bot's Migrated entry): NO `package.json` (pnpm workspace
  globs `apps/*` — a package.json would drag the app into vp/knip/oxlint), `Cargo.lock`
  kept for `--locked`, `rust-toolchain.toml` pin, validation is Cargo-native
  (`fmt --check`, `clippy -D warnings`, `build --locked`, `test`), oxfmt owns `.toml`/`.md`.
- Monorepo `main` == `origin/main` (b17c3592, slide tip); `migrate-matrix-bot` is ahead of
  main and NOT locally merged (it awaits its own GitHub PR). Nothing on this host runs from
  the Monorepo checkout (ps/systemd audit clean); its worktree is clean on migrate-matrix-bot.
- Host: rustup 1.96.0 (fmt+clippy present), docker 29.6 (no local rust image — pull needed),
  codex-cli 0.133.0 at /usr/bin/codex.

### Re-plan decisions

| #   | Decision                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N11 | Finish original Phase 5 (release build + summary) on janet-manager FIRST, then migrate                                                                                                                                                          | the directive calls my N1.1 work "the source that gets migrated in" — the source branch should be complete and green per its own brief                                                                                                                                                                         |
| N12 | Monorepo work happens in a `git worktree` on new branch `migrate-manager`, branched from `main`                                                                                                                                                 | zero disturbance to the existing `migrate-matrix-bot` checkout (never-touch rule); basing on main avoids self-merging matrix-bot's unmerged branch as a side effect (not mine to merge); the MIGRATION.md list will conflict trivially with matrix-bot's entry at some future merge — human-resolvable, logged |
| N13 | Import the FULL janet-manager history (precedent: history-preserving merge), then flatten `manager-rs/*` → `apps/manager/`                                                                                                                      | matches "flatten redundant nesting" (app/web → web); `git log --follow` keeps walking                                                                                                                                                                                                                          |
| N14 | Cleanup drops `package.json` + `manager.js`; keeps `docs/contracts/` under apps/manager                                                                                                                                                         | package.json is MANDATORY to drop (workspace glob) and its bin/scripts point at the JS manager = standalone cruft; manager.js is the superseded baseline, retrievable from imported history; the contracts are the N0.1 source of truth the app implements — they ride along where history lands them          |
| N15 | Keep `flake.nix`/`nix/`/`flake.lock`                                                                                                                                                                                                            | build tooling (dream2nix, build-verified 8c7b9df), not per-app deploy cruft; invisible to JS tooling; NOT nix-built this run unless cargo build has succeeded (§0)                                                                                                                                             |
| N16 | Add `rust-toolchain.toml` pinning 1.96                                                                                                                                                                                                          | precedent pins matrix-bot to its CI toolchain; the manager's validated toolchain is host 1.96 (no CI existed); rustup already has 1.96 → no download                                                                                                                                                           |
| N17 | Container = `rust:1.96-slim` (pull; docker hub egress expected — crates.io works, only github doesn't resolve), `--cpus=2`, `CARGO_BUILD_JOBS=2`, fresh container CARGO_HOME, source mounted read-only, `CARGO_TARGET_DIR` inside the container | isolated clean-env proof per directive §2 within §0 budget caps; read-only mount keeps root-owned files out of the worktree. Fallback if hub unreachable: `cargo vendor` + a local base image — will log if taken                                                                                              |
| N18 | Loop = container run of `cargo fmt --check && clippy -D warnings && build --locked --release && test` until green                                                                                                                               | directive §3; this is exactly the matrix-bot validation set; the release build inside the container also satisfies the original brief's release-build deliverable in the final target                                                                                                                          |
| N19 | Sol review: `codex exec` non-interactively over the `main..migrate-manager` diff; address feedback in the loop; re-review if substantial; outcome logged here                                                                                   | directive §4 verbatim                                                                                                                                                                                                                                                                                          |
| N20 | After Sol passes: `git merge --no-ff migrate-manager` into local `main` (standard-merge per journal); DO NOT push; log "push pending — human"                                                                                                   | directive §5; MIGRATION.md says standard-merged, not squashed                                                                                                                                                                                                                                                  |

### Execution order (updated)

P5 (source complete) → M1 import+flatten → M2 cleanup/tooling commits → M3 container
build-test loop → M4 Sol review (+fixes) → M5 record in MIGRATION.md, local merge to main,
final summary + open questions, stop.

## Phase 5 — Source branch complete (build/test log)

- `cargo check --all-targets`: clean. `cargo test`: **21/21 green**. One
  `cargo build --release`: green in 36.6s (`agent-manager 0.1.0`, 2.6 MB stripped+lto).
  All runs `CARGO_BUILD_JOBS=2 nice -n19`; load stayed under 8 cores throughout.
- All five original phases committed on `feat/N1.1-manager-core`. Per the updated
  directive this branch is now the SOURCE for the monorepo migration (phases M1–M5);
  the final completion summary + open questions land at the end of M5.

### Plan (phases 2–5)

1. **P2** `state.rs`: Heartbeat v2 struct (+ `ChannelLock`), `supervisor.rs::write_heartbeat`
   emits v2 (+handle+stub lock); `health.rs` reads v2, tolerates v1 with a note; unit tests
   for serialization shape + v1/v2 parse. Commit.
2. **P3** `config.rs`: `schema_version` field + conformance tests (example file parses;
   {creds_path, control_room} required; typo'd key errors; schema_version accepted).
   `state.rs`: SessionState schema_version + legacy-file round-trip test. Commit.
3. **P4** `supervisor.rs`: extract `parse_reset_at`; `#[cfg(test)]` module with a
   `test_supervisor()` builder; table tests for handle_exit paths + hook-file parsing.
   Commit.
4. **P5** `CARGO_BUILD_JOBS=2 nice -n19 cargo check` / `cargo test` / one
   `cargo build --release`; final summary + open questions here. Commit.

## M1+M2 — Monorepo import + cleanup (implemented)

- Import per precedent: relocate commit in a source clone (`git mv` ALL contents incl. the
  root `.gitignore` — first merge attempt conflicted on it, aborted, amended, re-merged),
  `merge --allow-unrelated-histories` into worktree branch `migrate-manager` (from `main`),
  flatten `manager-rs/*` → `apps/manager/`.
- Cleanup commits in journal order: cruft drop (package.json — MANDATORY, `apps/*` pnpm
  glob — plus superseded manager.js; both retrievable from imported history), toolchain pin
  (1.96), `vp fmt` reformat (own commit + blame-ignore; needed Node 26 via nvm — the repo
  gates on `^26`, default node is 25), `cargo fmt` reformat (own commit + blame-ignore —
  the source was never rustfmt-enforced; 100% mechanical).
- Secrets audit across ALL source blobs (token/key patterns): clean.
- `cargo clippy --all-targets -- -D warnings`: clean on first run — no lint-fix commit
  needed. rustup fetched 1.96.1 components for the pin (rust-lang CDN resolves; only
  github.com doesn't).
- N21: from here decisions log in THIS copy (apps/manager/…/DECISIONS-N1.1.md) — it is the
  migrated artifact; janet-manager gets a final pointer commit at the end.

## M3 — Isolated container validation (green)

- `rust:1.96-slim` (pulled fresh), `--cpus=2`, `CARGO_BUILD_JOBS=2`, source mounted
  READ-ONLY, target dir + CARGO_HOME inside the container (clean env; toolchain pin
  honored — rustup pulled 1.96.1 default profile in-container).
- Loop iteration 1: `cargo fmt --check` OK, `clippy --all-targets --locked -D warnings`
  OK, `cargo test --locked` **21/21**, `cargo build --locked --release` OK
  (`agent-manager 0.1.0`). Re-ran the test step under `set -euo pipefail` after noticing
  the first run's piping could mask a test failure — explicitly verified green.
- Loop converged in one iteration; cached named volume `manager-n11-target` kept for
  cheap re-runs if Sol review forces changes.
