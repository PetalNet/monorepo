# N0.1 Shared Contracts — DECISIONS log

Fable, overnight 2026-07-09, branch `docs/N0.1-contracts`. Docs/spec only — no service
code, no builds, no live changes. Every pick-and-log choice lands here with a rationale.

## Phase 1 — Ground-truth findings (what each current shape actually is)

### 1. Session state (`manager-rs/src/state.rs::SessionState`)
- On-disk file (default `~/.claude/shared/agent-session-state.json`, mode 0600, atomic write):
  `{"sessionId": "<uuid>", "bootstrapped": <bool>}`.
- `sessionId` is camelCase **on purpose** — drop-in rollback compatibility with manager.js.
- `bootstrapped` absent ⇒ defaults **true** (legacy manager.js file ⇒ already-running session ⇒ resume).
- Semantics: `bootstrapped=false` ⇒ launch `--session-id <id>`; `true` ⇒ `--resume <id>`.
- No version field today.

### 2. Heartbeat (`manager-rs/src/state.rs::Heartbeat`, written every 1s tick by supervisor.rs)
- snake_case JSON at `~/.claude/shared/agent-manager-heartbeat.json`:
  `schema` (u32, currently literal `1`), `version` (cargo pkg version), `pid`, `state`,
  `session_id`, `tmux_session`, `pane_id` (string|null), `io_ok` (bool), `crash_count`,
  `started_at_epoch` (u64 secs, 0=never), `last_sync_ok_epoch`, `updated_at_epoch`.
- `state` enum (supervisor.rs::AgentState): `starting | running | rate_limited | waiting | crashed | stopped`.
- Consumer: `healthcheck` subcommand (health.rs) — asserts heartbeat fresh (default ≤30s),
  pid alive, state ∈ allowed (default `running`), pane alive+tagged when running,
  Matrix `/sync` fresh (default ≤120s, `last_sync_ok_epoch`, 0 = never ⇒ fail).
- Already versioned, but with key `schema`, not `schema_version`.

### 3. Manager config (`manager-rs/src/config.rs::RawConfig`)
- JSON file pointed at by `$AGENT_MANAGER_CONFIG`; `#[serde(deny_unknown_fields)]` — typos fail at boot.
- Required: `creds_path` (Matrix creds JSON `{homeserver, access_token, user_id}`), `control_room`.
- Optional (defaults in parens): `agent_name` ("agent"), `work_dir` (CLI arg > config > $HOME),
  `state_path`, `rate_limit_hook_path`, `model_override_path`, `exit_code_path`, `heartbeat_path`,
  `sessions_dir`, `tmux_session` ("agent-claude"), `pane_tag` ("agent-manager"),
  `claude_bin` ("claude"), `claude_args` (["--dangerously-skip-permissions"]),
  `path_prepend` (~/.local/bin), `kill_agent_on_shutdown` (true), `tmux_width` (220), `tmux_height` (50).
- `~`-expansion on all path fields. No version field today.

### 4. Fleet status/event JSON (`tasks/src/lib/server/fleet.js` + live `data/fleet/<handle>.json`)
- Written by Claude Code lifecycle hooks (SessionStart/PreToolUse/PostToolUse/Stop) as a
  **current-status snapshot, overwritten per event** — not an append-only event stream.
- Live sample (janet.json): `{"handle","host","status","current_tool","started_at","updated_at","session_id"}`
  with `status ∈ alive|working|idle`, ISO-8601 UTC timestamps, `current_tool`/`session_id` nullable.
- Consumer (fleet.js) derives: `offline` when `updated_at` older than 90s (STALE_MS);
  handle lowercased (filename wins); host normalized `dotN` → `.N`; joins focus task via
  `activeLeases()` (status='doing' AND assignee=handle). Roster stubs fill in never-seen agents.
- No version field today; hook host string drifts ("dot14" vs ".14") — normalization lives in the consumer.

### 5. Queue / leases (`tasks/src/lib/server/db.js` + tasks.db schema)
- `tasks` table: `status ∈ inbox|todo|doing|blocked|done|dropped` (plus `review` accepted via
  reportTask), `priority` 0..3 (0 highest), `kind ∈ task|idea|doc|question`, plus delegation
  columns: `assignee`, `capability`, `claimed_by`, `claim_token` (SERVER-ONLY SECRET — scrubbed
  from anything browser-bound), `lease_expires_at` (TEXT, SQLite `datetime('now','+30 minutes')`
  i.e. `YYYY-MM-DD HH:MM:SS` UTC), `handoff_context`, `acceptance_criteria`, `result_summary`,
  `verification_status ∈ unverified|verified|rejected`, `suggested_agent`, `effort`,
  `parallel_group`, `close_reason`, `up_next`, `rank`, `parent_id`, `blocked_on`, `visibility`.
- Atomic claim: single guarded UPDATE (better-sqlite3 single-writer) — `claimTask(id, worker, token)`
  requires `assignee=worker AND status='todo' AND lease expired-or-null`; `claimNext(worker, filters)`
  CAS-claims top Up-Next by `rank, priority`; token = `crypto.randomUUID()`; lease = **30 minutes**.
- `reportTask` gated on `claimed_by==worker && claim_token==token`; report status ∈ review|blocked|done.
- Any transition out of `doing` clears `{claimed_by, claim_token, lease_expires_at}`.
- `reapLeases()` → expired `doing` back to `todo` (optionally scoped to one `claimed_by`).
- `closeTask` REQUIRES a reason (why-ledger; emits `closed` event). `verifyTask(ok)` →
  verified+done or rejected+todo+lease-cleared.
- `agents` registry: `handle` (PK, lowercase), `display_name`, `host`, `role`, `lane`,
  `capabilities` (CSV — the enforced lane gate, looked up server-side, never trusted from caller),
  `autonomy ∈ auto|ask|readonly|paused`, `active` 0/1.
- Known gap (fleet-dispatcher-review §4): lease expiry ≠ proof the old worker stopped —
  fencing tokens/idempotency needed so a zombie can't commit after reap+reclaim.

### 6. Doorman RPC envelope — NO checkout, NO network
- `/home/docker/doorman` does not exist on this host and github.com does not resolve from here
  (verified: `git ls-remote` → "Could not resolve host"). Per the brief's fallback, the envelope
  is spec'd from the gallery doc `fleet-doorman-tunnel-design` (+ fleet-manager-spec v2 §6–7).
- Transport facts from the design doc: wss/443 → Caddy → doorman-edge; yamux multiplex; Noise
  auth *inside* TLS; per-agent static keypairs; 2 warm conns; heartbeat 15–20s; **app-level
  session resume** (session token, edge re-attaches agent to its slot, in-flight RPCs retried
  **idempotently by the caller** ⇒ envelope needs idempotency keys); Matrix homeserver is the
  never-dark floor (so the envelope must be transport-agnostic — same JSON over doorman or Matrix).
- **Discrepancy found:** the design doc says Noise **NK**, the DAG plan and this brief's LOCKED
  section say Noise **XK**. Handshake choice doesn't change the JSON envelope (it's inside the
  authenticated stream) — logged as an open question for Parker, envelope spec'd transport-agnostic.

### 7. Interrupt / ownership context
- LOCKED: only 3 interrupt classes reach Janet mid-task: direct Parker/Eli command, safety,
  active-task clarification ⇒ `interrupt_policy` enum on the task-card.
- LOCKED: single-owner Matrix lock is load-bearing (matrix-channel-rs; Focus-squat reboot race
  2026-07-09) ⇒ manager↔channel contract must carry ownership/lockout state.
- LOCKED: tracker is source of truth; every agent action ties to a task id (spawn-from-task).
- Backchannel rooms are a 1:1 star (agent↔manager), never agent↔agent gossip (fleet-manager-spec §7).
- DAG-plan gotchas honored: no Nix assumption for agent machines (Windows first-class ⇒ contracts
  OS-neutral: no tmux/paths/PIDs required fields where a platform can't supply them);
  Doorman is the sole backchannel.

### Phase 1 decisions
| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Doorman envelope spec'd from the gallery design doc, not source | repo absent + no DNS/network from this host; brief explicitly allows this fallback |
| D2 | Noise NK-vs-XK discrepancy: envelope stays handshake-agnostic; flagged to Parker | the JSON envelope rides inside the authenticated stream either way; not mine to relitigate |
| D3 | Treat `data/fleet/<handle>.json` as a *snapshot* contract fed by lifecycle *events*; schema models the event, snapshot = latest event | matches what the hooks actually write and what fleet.js actually reads |

## Phase 2 — Schema drafting decisions
(recorded after drafting; see below)
