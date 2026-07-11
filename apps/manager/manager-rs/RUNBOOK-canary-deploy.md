# Runbook: agent-manager (Rust) — Scout-canary deploy, healthcheck gates, local rollback

task-561. Aligns with `janet-manager/FABLE-SPEC-canary-deploy.md`.
Final repo home: `PetalNet/monorepo` (apps/agent-manager). This directory is the staging
port — **do not push from here**; move it in as its own reviewed change.

**Status: WRITTEN, NOT RUN.** No part of this has executed against a live agent. A human
plus the Scout canary validate everything below before it touches Janet. See
"Untested / needs human review" at the bottom.

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
(schema: appendix A). No lab paths/rooms/tokens are compiled in.

## 2. On-host layout (both Scout and Janet's host)

```
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

```sh
V=<version>
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
1. heartbeat fresh (default ≤30s) and manager pid alive — process up under systemd;
2. state `running` and the recorded tmux pane id exists **with our ownership tag**;
3. manager's Matrix `/sync` succeeded within the last 120s — connected to Matrix.

**Not covered by the subcommand:** "agent answers a ping over Matrix" (FABLE-SPEC
assert 3). That needs a second Matrix identity; the deploy driver does it: send a
message to the agent from the deploy account, require any reply/reaction within N
minutes. Until that driver exists it is a manual step in the canary window.

Window discipline: run healthcheck at boot+60s (startup prompts + first sync take
time), then every minute for the window (Scout: ≥30 min suggested — long enough to see
one full crash/backoff cycle if the build is bad).

## 5. Canary flow (Scout first, Janet only if Scout survives)

```
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

Rules (from FABLE-SPEC, non-negotiable):
- rollback is driven **from outside the target process** (ssh / local shell), because a
  broken manager may be too broken to talk;
- promotion to Janet is **one deliberate restart, never a loop** — if the first
  post-promote healthcheck fails, you roll back, you do not retry V on Janet;
- every FAIL fires an alert; silence is not an option for a harness component.

## 6. Rollback (LOCAL, no network)

```sh
cd ~/agent-manager
ln -sfn "$(readlink last-good)" current
systemctl --user restart <agent>.service
AGENT_MANAGER_CONFIG=~/agent-manager/config.json ./current healthcheck   # verify recovery
```

That is the whole procedure. It works with the homeserver down, the cache down, and
the internet down. If even `last-good` fails healthcheck, the incident is not a deploy
regression — debug the host, and as a last resort the JS manager remains runnable:
`node /home/docker/manager.js /home/docker` behind the old unit (keep manager.js
untouched until the Rust manager has survived on Janet for a comfortable period).

## 7. Migration from manager.js (first Janet deploy only)

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
  carrying our tag; it never guesses at untagged panes (mis-adopting a human's nano
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

## 9. Untested / needs human review before canary

Honest list; none of this has run against a live agent:

1. **Never executed end-to-end.** Only `cargo check`/`clippy`-level validation was
   performed on this host. No spawn, no Matrix call, no tmux call has been made by
   this binary.
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
11. **PARCS checkin de-tmux** (FABLE-SPEC deliverable 6) — out of scope of this crate,
    still open.

## Appendix A: config schema (`$AGENT_MANAGER_CONFIG`, JSON)

Required: `creds_path` (JSON with `homeserver`, `access_token`, `user_id`),
`control_room`. Optional (defaults in parentheses, `~` expands):
`agent_name` ("agent"), `work_dir` ($HOME; CLI arg wins), `state_path`,
`rate_limit_hook_path`, `exit_code_path`, `heartbeat_path`
(~/.claude/shared/agent-*), `model_override_path` (unset = no --model),
`sessions_dir` (~/.claude/sessions), `tmux_session` ("agent-claude"),
`pane_tag` ("agent-manager"), `claude_bin` ("claude"), `claude_args`
(["--dangerously-skip-permissions"] — lab flags like the matrix channel and --name go
HERE), `path_prepend` (~/.local/bin), `kill_agent_on_shutdown` (true),
`tmux_width`/`tmux_height` (220/50). Unknown keys are a boot error by design.
