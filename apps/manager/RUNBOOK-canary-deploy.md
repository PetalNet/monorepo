# Runbook: agent-manager (Rust) — manual canary deploy, health gates, local rollback

The binary and configuration described here live in `apps/manager`. This is an operator
procedure, not deploy automation: this repository contains no Scout→Janet canary driver,
release installer, systemd unit, or automatic promotion/rollback. Host names and layouts
below are historical deployment examples and must be checked against the target host.

**Status: MANUAL PROCEDURE; LIVE DEPLOYMENT NOT VERIFIED HERE.** Run each gate from an
external operator shell and require human approval before promotion.

## 1. What this binary is

`agent-manager` supervises a persistent Claude Code session in a tmux pane:

- spawn on boot; first boot of a fresh session id uses `--session-id <id>`, every
  later boot uses `--resume <id>` (state file records `bootstrapped`);
- rate-limit exits (hook drop file `{"resetAt": ...}`) wait until reset + 15s, then resume;
- crashes retry with 5s→30min doubling backoff, quick-crash counting, stop after 10;
- Matrix control room `!commands`: `start stop restart status kill session` + a
  hard-allowlisted slash passthrough (`/compact /context /cost /status` only);
- **stable pane ownership**: the agent pane is stamped with tmux user option
  `@agent_manager_owner=<pane_tag>` and addressed by its immutable pane id (`%N`) for
  every send-keys / capture / kill. Never "active pane", never "pane 0". Humans may
  open panes/windows in the same session freely; stop/restart kills only our pane and
  respawn goes into a new window rather than nuking the session.
- heartbeat JSON rewritten every second; `agent-manager healthcheck` gates on it.

Everything host-specific comes from the JSON config at `$AGENT_MANAGER_CONFIG`
(example: [`config.example.json`](config.example.json)). No lab paths/rooms/tokens are
compiled in.

## 2. Example on-host layout (deployment-specific)

```text
~/agent-manager/
  releases/<version>/agent-manager     # immutable unpacked releases (version = git sha or semver)
  current    -> releases/<B>/agent-manager    # symlink, what systemd runs
  last-good  -> releases/<A>/agent-manager    # symlink, LOCAL rollback target
  config.json                          # host-specific config (this repo's IaC side)
```

- systemd unit `ExecStart` points at `.../current run /home/<user>` with
  `Environment=AGENT_MANAGER_CONFIG=/home/<user>/agent-manager/config.json`.
- **`last-good` and its release directory are ordinary local files.** Rollback is a
  symlink flip + service restart: no network, no binary cache, no nix daemon needed.
  The Nix/dream2nix build + cache is used **only for forward deploys** (producing
  `releases/<version>` faster/cacheably). Never garbage-collect a store path that
  `last-good` resolves into — which is why releases are **copied out of the store**
  into `releases/`, not symlinked into `/nix/store`.

## 3. Forward deploy (one target)

This procedure requires an already-verified baseline. Before replacing `current`,
prove that both the running target and offline rollback target resolve to executable
files. A first deployment must establish and verify those symlinks outside this
canary procedure.

```sh
set -eu
V=<version>
current_target=$(readlink -f ~/agent-manager/current)
rollback_target=$(readlink -f ~/agent-manager/last-good)
test -x "$current_target"
test -x "$rollback_target"

# build: either `cargo build --release`, or `nix build .#default` (dream2nix, cache-backed)
install -D -m755 <built-binary> ~/agent-manager/releases/$V/agent-manager
~/agent-manager/releases/$V/agent-manager version       # sanity: runs at all
ln -sfn releases/$V/agent-manager ~/agent-manager/current
systemctl --user restart <agent>.service               # ONE deliberate restart (Matrix blip)
```

Promotion of `last-good` happens only AFTER the healthcheck window passes (step 5).

## 4. Healthcheck (the gate)

```sh
AGENT_MANAGER_CONFIG=~/agent-manager/config.json ~/agent-manager/current healthcheck
```

Asserts (exit 0 = healthy):

1. heartbeat fresh (default ≤30s) and the recorded manager pid alive (this does not
   prove that systemd owns the process);
2. state `running` and the recorded tmux pane id exists **with our ownership tag**;
3. manager's Matrix `/sync` succeeded within the last 120s — connected to Matrix.

**Not covered by the subcommand:** "agent answers a ping over Matrix". That needs a
second Matrix identity; an external operator or deploy driver must send a
message to the agent from the deploy account, require any reply/reaction within N
minutes. Until that driver exists it is a manual step in the canary window.

Window discipline: run healthcheck at boot+60s (startup prompts + first sync take
time), then every minute for the window (Scout: ≥30 min suggested — long enough to see
one full crash/backoff cycle if the build is bad).

## 5. Manual canary flow (example: Scout first)

```text
deploy V to Scout                      (step 3, on scout-pc over ssh)
  └─ healthcheck window (≥30 min)
       ├─ PASS ⇒ on Scout: ln -sfn releases/V/agent-manager last-good
       │        deploy V to Janet's host (.14)
       │          └─ post-promote healthcheck window on Janet (same gates —
       │             .14-specific breakage won't show on Scout's box)
       │               ├─ PASS ⇒ on .14: ln -sfn releases/V/... last-good   ✅ done
       │               └─ FAIL ⇒ ROLLBACK Janet (step 6) + alert (shawn-send)
       └─ FAIL ⇒ NO promote. ROLLBACK Scout (step 6) + alert (shawn-send)
```

Operational safety rules:

- rollback is driven **from outside the target process** (ssh / local shell), because a
  broken manager may be too broken to talk;
- promotion to Janet is **one deliberate restart, never a loop** — if the first
  post-promote healthcheck fails, you roll back, you do not retry V on Janet;
- every FAIL fires an alert; silence is not an option for a harness component.

## 6. Rollback (LOCAL, no network)

```sh
set -eu
cd ~/agent-manager
rollback_target=$(readlink -f last-good)
test -x "$rollback_target"
ln -sfn "$(readlink last-good)" current
systemctl --user restart <agent>.service
AGENT_MANAGER_CONFIG=~/agent-manager/config.json ./current healthcheck   # verify recovery
```

The symlink rollback itself needs no network. The subsequent healthcheck still requires
fresh Matrix sync, so it will fail while the homeserver is unavailable. If `last-good`
also fails, diagnose the host and dependencies; any legacy JS fallback is host-specific
and is not maintained by `apps/manager`.

## 7. Historical manager.js migration notes (deployment-specific)

1. `systemctl --user stop janet.service` — **the JS manager kills the tmux session on
   SIGTERM**; that is expected and means the Rust manager starts from a clean slate.
2. Point the unit at `~/agent-manager/current run /home/docker`, add
   `Environment=AGENT_MANAGER_CONFIG=...`, `daemon-reload`, start.
3. The Rust manager reads the SAME state file (`janet-session-state.json`,
   camelCase `sessionId` preserved); a legacy file without `bootstrapped` is treated
   as bootstrapped ⇒ first Rust boot resumes Janet's existing conversation.
4. Do NOT start the Rust manager while the JS manager is running (both would fight
   over the session; the Rust manager will not adopt untagged panes and would spawn a
   second claude that then trips over the session lock).
5. Rolling back to JS: stop unit, restore old `ExecStart`, start. The state file stays
   compatible in both directions.

## 8. Port notes for reviewers (JS → Rust deltas that are deliberate)

- **Pane ownership** — JS pinned `janet-claude:0.0` (post-panefix); Rust stamps
  `@agent_manager_owner` on the pane and targets the pane id. Titles were rejected as
  the tag: Claude Code rewrites terminal titles (OSC), tmux maps those onto
  `pane_title`, so titles are not stable; user options are untouchable by the program
  in the pane. tmux ≥ 3.0 required (host has 3.4).
- **Liveness** — JS: `has-session` (agent death invisible while humans kept other
  panes open). Rust: "our tagged pane id exists". Stop/restart kill only our pane.
- **Adoption** — JS adopted whenever the session existed. Rust adopts only a pane
  carrying our tag; it never guesses at untagged panes (wrongly adopting a human's nano
  pane is exactly the bug the panefix fought). Consequence: an agent left over from a
  manager that died before tagging is NOT re-adopted — see §7 step 4.
- **First-boot vs resume** — restored (JS's two branches had decayed to identical
  `--resume`); fresh ids launch with `--session-id`. Needs canary verification.
- **Supervision never blocks on Matrix** — sends go through a queued thread with 15s
  timeouts; sync failures back off 5s (JS could stall on a wedged send and hot-loop
  sync on transport errors).
- **Spawn failure handling** — tmux errors enter the normal crash-backoff path and
  count as quick crashes (so a permanently broken tmux stops after 10 tries instead
  of retrying+messaging every 5s forever).
- **Dropped dead JS code** — `parseResetDate`/`RATE_LIMIT_RE` (scrape-based rate-limit
  detection), `stripAnsi`, the unused `RESUMING` state, the redundant slash denylist
  (allowlist already refuses everything else). Rate-limit detection is hook-file only,
  exactly as the live JS behaves.
- **Same-shape side files** — session state (`sessionId`), exit-code file, rate-limit
  hook file, model-override file, stale session-lock cleanup: all read/written
  compatibly with the JS manager and the existing hooks.

## 9. Deferred deployment requirements

The removed held execution brief also proposed capabilities that are **not** completed
by this manual runbook. They remain deferred rather than silently accepted:

1. a Scout-first deploy driver with automatic promotion, rollback, and alerting;
2. an agent-responsive Matrix ping from a second identity as an automated health gate;
3. rewriting the external PARCS check-in and teardown scripts to use
   `system-enqueue` instead of `tmux send-keys`.

These require work in deployment or external repositories. Do not infer their
completion from the existence of `apps/manager` or this procedure.

## 10. Untested / needs human review before canary

Honest list; none of this has run against a live agent:

1. **Never executed end-to-end against a live deployment.** CI runs unit tests and
   real tmux integration tests on isolated scratch sockets, but no live agent,
   Matrix homeserver, systemd unit, or canary target has been verified by them.
2. **`--session-id` first-boot path** — restored from the spec'd intent, but the JS
   manager has been running `--resume`-only; verify on Scout that a fresh id boots and
   that `kill session` → auto-restart lands in a fresh conversation.
3. **Rate-limit resetAt format** — the hook writes whatever Claude emits; parser
   accepts RFC3339 / epoch s / epoch ms, but the real payload format has not been
   observed by me. Check the next real rate-limit event on Scout.
4. **Startup-prompt auto-accept phrases** — copied verbatim from manager.js; Claude
   Code versions drift. Watch Scout's first boot (`tmux attach -r` read-only).
5. **dream2nix flake** — written from memory, no nix on this host; flagged NEEDS-REVIEW
   in-file. The `fallback` (`rustPlatform.buildRustPackage`) and plain cargo are the
   dependable paths.
6. **ureq/TLS against mx.petalcat.dev** — rustls handshake, the sync long-poll
   timeout margins, and Matrix error shapes are untested against a real homeserver.
7. **Matrix send txn-id scheme** (epoch-seeded counter) — dedup semantics vs the JS
   Date.now() scheme unverified against Synapse.
8. **kill_agent_on_shutdown=false adopt path** — the blipless-deploy option is coded
   but should be exercised on Scout before anyone relies on it; default (true)
   matches JS behavior.
9. **Healthcheck thresholds** (30s heartbeat / 120s sync) are judgment calls, not
   measurements; tune on Scout.
10. **agent-responsive ping** — not in the binary (needs a second Matrix identity);
    manual step or deploy-driver work, see §4.

## Appendix A: config schema (`$AGENT_MANAGER_CONFIG`, JSON)

Required: `creds_path` (JSON with `homeserver`, `access_token`, `user_id`),
`control_room`. Optional (defaults in parentheses, `~` expands):
`agent_name` ("agent"), `work_dir` ($HOME; CLI arg wins), `state_path`,
`rate_limit_hook_path`, `exit_code_path`, `heartbeat_path`
(~/.claude/shared/agent-\*), `model_override_path` (unset = no --model),
`sessions_dir` (~/.claude/sessions), `tmux_session` ("agent-claude"),
`pane_tag` ("agent-manager"), `claude_bin` ("claude"), `claude_args`
(`["--dangerously-skip-permissions"]` — lab flags like the matrix channel and --name go
HERE), `path_prepend` (~/.local/bin), `kill_agent_on_shutdown` (true),
`tmux_width`/`tmux_height` (220/50), `glitchtip_dsn` (unset).

The optional assistant HTTP service is enabled only when **both** `assistant_api_bind`
and `assistant_api_token` are set. The bind must be a loopback IP socket address and the
token must contain at least 32 characters. Other options are `assistant_receipts_path`
(`~/.claude/shared/assistant-manager-receipts.json`) and `assistant_model` (unset).
Routes are unauthenticated `GET /healthz`, plus authenticated
`POST /v1/sessions/ensure`, `POST /v1/sessions/{id}/messages`, and
`POST /v1/sessions/{id}/messages/lookup`. Authenticated routes require
`Authorization: Bearer <assistant_api_token>` and v1 JSON bodies.

Keep the listener loopback-only and terminate TLS/authentication at the local console
proxy. The receipt ledger is mode 0600 and does not persist caller-scoped MCP credentials.
Browser authorization, proxying, credential minting, and deployment are external to this
app. Unknown config keys are a boot error. `config.example.json` and `src/config.rs` are
the authoritative implemented shape.
