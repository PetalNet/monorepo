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
| # | Decision | Rationale |
|---|----------|-----------|
| N1 | No dual-key transition window: write `schema_version: 2` only; health.rs updated in the same commit (brief default for N0.1 open question #3) | manager + healthcheck are one binary shipping as one unit; a v1-tolerant *reader* covers the only real skew (new healthcheck binary vs old running manager) |
| N2 | health.rs v1 tolerance via `#[serde(alias = "schema")]` on `schema_version` + a deprecation note when the parsed version is 1 | one struct, no second parse path; a v1 file (`schema: 1`) still deserializes and the note makes the legacy shape visible in healthcheck output |
| N3 | `channel_lock` is a STUB: constant `{state: "held", acquired_at_epoch: 0}` until N1.3/N2.2 wires the real matrix-channel lock | brief mandates the stub; `held` is the only truthful value for today's single-manager deploy; 0 = unknown per schema |
| N4 | `handle` = `agent_name` lowercased at heartbeat-write time | contract pattern requires lowercase; rule 0.4 makes normalization the producer's job; config keeps accepting any display name |
| N5 | Heartbeat `tmux_session` becomes `Option<String>` (this manager always writes `Some`) | contract says string\|null and consumers MUST NOT require it; makes the healthcheck reader OS-neutral now, zero behavior change on this host |
| N6 | Optional heartbeat fields serialize with `skip_serializing_if = "Option::is_none"` (handle/channel_lock; lock's owner/contender) | `additionalProperties: false` + optional = omit-when-absent is the cleanest conforming shape; avoids emitting nulls the schema only sometimes allows |
| N7 | Refactor limited to extracting `parse_reset_at(&Value) -> Option<DateTime<Utc>>` from `check_rate_limit_hook_file` | the parse matrix (RFC3339/secs/millis/garbage) becomes a pure-function table test; file-consumption semantics still get their own test; no redesign |
| N8 | Tests write scratch files under `std::env::temp_dir()/agent-manager-test-<pid>-…`, never `~/.claude/shared/` | REVIEWABLE-ONLY rule: the live shared state dir is untouchable, and tests must not depend on host layout |
| N9 | `SessionState` gains `schema_version: u32` defaulting to 1 and always serialized | contract: absence = 1 on read, producers MUST write it; manager.js rollback ignores extra keys so writing it is rollback-safe |
| N10 | `RawConfig` gains `schema_version: Option<u32>`, accepted and ignored (allow(dead_code)) | brief deliverable 2 verbatim: accept const-1 key, no behavior; validation of the value stays with the external schema validator |

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
