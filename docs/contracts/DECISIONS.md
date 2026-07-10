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

Six files under `docs/contracts/schemas/`, all JSON Schema draft 2020-12.

| # | Decision | Rationale |
|---|----------|-----------|
| D4 | `$id` base URI `https://schemas.petalnet.lab/contracts/v1/…` | need stable, resolvable-later ids for cross-file `$ref`; `.lab` makes clear it's not a public host |
| D5 | `schema_version` is an integer, pinned with `const` per schema revision; absence = the pre-contract legacy version | LOCKED versioning requirement; `const` makes validators reject wrong-version instances instead of silently passing |
| D6 | Heartbeat contract is `schema_version: 2`; v1 ≙ the live shape whose key is `schema: 1`. v2 = rename to the fleet-standard key + add optional `handle` + `channel_lock` | the deployed field name `schema` collides with the fleet standard; treating live as v1 gives a clean migration story instead of two version fields |
| D7 | Heartbeat keeps epoch-seconds timestamps; all NEW contracts use RFC 3339 UTC strings | healthcheck freshness math is epoch arithmetic and the shape is deployed — no gratuitous churn; everything new matches what fleet files/SQLite-adjacent JS already do (ISO strings) |
| D8 | `sessionId` stays camelCase in session-state | explicit manager.js rollback-compatibility comment in state.rs; renaming buys nothing and breaks rollback |
| D9 | `tmux_session`/`pane_id` kept by name but nullable/optional; consumers must not require them | OS-neutrality (LOCKED, Windows first-class) without inventing an untested "workspace" abstraction tonight |
| D10 | Channel ownership modeled as `$defs/channelLock` {state: held\|released\|lockout, owner, acquired_at_epoch, contender} embedded in the heartbeat | LOCKED single-owner requirement; the heartbeat is the manager's already-existing status surface, so the lock state becomes healthcheckable for free (Focus-squat race visibility) |
| D11 | Fleet event: schema models the EVENT; the snapshot file is defined as "the latest event". Added `event` (which hook) + `task_id` (spawn-from-task tie); producers must write canonical host ('.N') and lowercase handle; `offline` is consumer-derived, never written | matches what hooks actually write today; moves the dotN/handle normalization from consumer to producer contract; LOCKED task-id tie |
| D12 | `additionalProperties`: false everywhere EXCEPT fleet-event (true) | config is deny-unknown by existing design; state/lease/card/RPC are single-producer contracts where drift is the enemy; fleet events have many producers on many machines feeding one consumer — unknown fields must be skippable |
| D13 | Queue lease adds a REQUIRED monotonic `fence` (per-task, incremented per (re)claim; store rejects stale-fence writes) | dispatcher-review §4: lease expiry ≠ proof the worker stopped; fencing is the accepted fix (Kleppmann), and the ~/.claude/queue prototype already validated the pattern locally |
| D14 | `claim_token` stays a server-minted uuid SECRET; schema also defines `leasePublic` (token-scrubbed projection) as the only form that may leave the server | mirrors db.js SECRET_COLS scrubbing — codifying it stops a future consumer from ever shipping the token to a browser |
| D15 | Lease duration surfaced as `lease_seconds` default 1800 | today's hard-coded `+30 minutes`, made explicit so renewals/heavier tasks can vary it without schema change |
| D16 | task-card: `task_id` REQUIRED (cards about new work are created after the dispatcher files the task); `sender_class` {principal\|agent\|system} stamped server-side | LOCKED tracker-is-source-of-truth/spawn-from-task; interrupt enforcement needs principal-ness the recipient can trust, and the dispatcher's roster — not the sender's claim — is the authority |
| D17 | `interrupt_policy` enum: `defer` (default) \| `principal_command` \| `safety` \| `task_clarification`; the three non-defer values are exactly the LOCKED interrupt classes, with honor conditions (principal_command ⇐ sender_class=principal; task_clarification ⇐ task_id matches the active lease) | models "only 3 things interrupt Janet" as data the dispatcher can enforce, not prose |
| D18 | task-card priority = integer 0..3, 0 highest | same scale + direction as tasks.priority — one convention, no mapping bugs |
| D19 | Card embeds `leasePublic` by cross-file `$ref`, never a claim_token | tokens travel only in the direct claim response to the worker |
| D20 | RPC envelope: `type` ∈ request\|response\|event\|heartbeat\|error; `id` doubles as the idempotency key; receivers de-dup on id | the doorman design requires caller-side idempotent retry after redial/resume — that only works if the envelope pins an idempotency key |
| D21 | Envelope carries NO session-resume/auth fields | resume + auth are transport-layer (Noise keypair, edge slot re-attach) per the design doc; keeping them out lets the identical envelope ride the Matrix floor |
| D22 | Conditional requirements via `allOf`/`if-then`: request/event ⇒ method; response/error ⇒ in_reply_to (+ error object) | keeps one envelope schema instead of five near-duplicates |
| D23 | `error.retryable` boolean + stable snake_case `error.code` | the caller's retry loop needs a machine answer to "may I resend this id?" |
| D24 | manager-config schema mirrors RawConfig exactly, `additionalProperties: false`, required = {creds_path, control_room}; defaults documented with `default` keywords; `$defs/matrixCreds` included | it IS the deny-unknown contract already enforced by serde; creds file shape included because config points at it |
| D25 | config `schema_version` optional (absence = 1) | the LIVE binary denies unknown fields, so requiring it would make every current config invalid; it becomes writable from the first rewrite release |

## Phase 3 — CONTRACTS.md
(see below)
