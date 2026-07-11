# FABLE-BRIEF — N1.2: tmux Layer (harness rewrite, Phase 1)

> **Node class: MERGE/HARDEN** — the hard problem (stable pane ownership) is already solved
> in `manager-rs/src/tmux.rs` and live. This node hardens, tests, and documents that layer
> and specs the declarative host config. No Parker gate.
>
> **Build weight: LIGHT** — mostly Rust unit/integration tests against a scratch tmux
> server + markdown/config output. One `cargo test` cycle.
>
> **⚠ Dependency gap the launcher must know:** the declarative host config
> (`janet-nix/modules/home/{tmux,ttyd}.nix`) lives in the `janet-nix` repo, which is NOT
> checked out on .14 and GitHub does not resolve from here. The nix half of this node is
> therefore SPEC-ONLY tonight (write the module content as a reviewable file in this repo);
> whoever has janet-nix ports it over. Do not attempt to clone.

## §0 — How to work (fully autonomous, unattended, no human mid-run)
- You are **Fable**, running alone. Brief = source of truth. Pick-and-log every free choice
  into `docs/contracts/fable-briefs/DECISIONS-N1.2.md` on your branch; never block.
- Repo: `/home/docker/janet-manager`. New branch **`feat/N1.2-tmux-layer`** from the tip of
  `feat/N-phase1-briefs`. Commit locally per phase; do NOT push; no PR.
- **REVIEWABLE-ONLY**: do not touch the LIVE tmux server's `janet-claude` session, its
  panes, or any pane carrying `@agent_manager_owner`. For integration tests, run a
  **separate scratch tmux server** on a private socket (`tmux -L n12test ...`) and kill only
  that server. Change no live config, restart no service.
- **Build budget:** `cargo test` with `CARGO_BUILD_JOBS=2`, `nice -n19`. No nix builds, no
  nixos-rebuild, ever.

## Mission
Make pane ownership a **tested, documented contract** instead of tribal knowledge: unit +
integration tests for the tagged-pane mechanism, explicit behavior on every tmux failure
mode (server gone, session gone, pane gone, tag clobber attempt, tmux < 3.0), and a
reviewable declarative spec for the host tmux/ttyd config (single pinned tmux version,
the options the harness relies on) that janet-nix can adopt verbatim.

## LOCKED decisions (do not relitigate)
- Identity = pane id (`%N`) + user option `@agent_manager_owner=<tag>`. NEVER the active
  pane, NEVER pane 0, NEVER pane titles (Claude Code clobbers titles via OSC), NEVER
  session-name liveness (humans keep panes open in the shared session — regression history,
  manager.js pane-fix 2026-07-01).
- Exact-name session targeting with leading `=` (bare `-t` prefix-matches).
- Humans co-habit the session: respawn goes into a NEW window; only OUR pane is ever killed.
- tmux ≥ 3.0 required (user options); host runs 3.4. A missing tag facility = failed spawn,
  not degraded operation.
- OS-neutrality lives ABOVE this layer (heartbeat tmux fields are nullable); this node is
  explicitly the POSIX/tmux implementation and may be POSIX-only.

## Read first (ground truth, all local)
- `manager-rs/src/tmux.rs` — the whole layer (~200 lines): Tmux, PaneInfo, spawn/tag/
  capture/send/kill plumbing. The header comment is the design doc; keep it true.
- `manager-rs/src/supervisor.rs` — every call site (spawn, adopt via `find_tagged_pane`,
  liveness poll, kill_pane on stop/restart, auto-accept thread using capture/send_keys).
- `manager-rs/src/health.rs` — `pane_alive` as a health assert.
- `manager.js` (repo root) — the pre-fix baseline that motivated all of this.
- `docs/contracts/CONTRACTS.md` §2 — what the heartbeat exposes (`tmux_session`, `pane_id`).
- `/home/docker/tasks/fleet-term/Dockerfile` + `/home/docker/tasks/docker-compose.fleet-term.yml`
  — the ttyd/fleet-term consumer that attaches to the HOST tmux socket read-only; your
  declarative spec must keep it working (socket path, permissions, uid 1000).

## Deliverables (branch `feat/N1.2-tmux-layer`, local commits only)
1. **Integration tests** (`manager-rs/tests/tmux_it.rs`, `#[ignore]`-gated behind env var
   `N12_TMUX_IT=1` so CI-less runs stay green): on a scratch `-L` socket — spawn window,
   tag pane, find_tagged_pane finds exactly ours among decoys, pane_alive true→kill→false,
   send_keys/capture round-trip, untagged pane never matches, second manager tag value
   doesn't collide. Clean the scratch server in every exit path.
2. **Failure-mode hardening** in `tmux.rs` (only where tests expose gaps): distinguish
   "tmux binary missing", "server not running", "session exists / pane gone"; every public
   fn documents its behavior on each. No API redesign — call sites must not change unless a
   bug forces it (log it if so).
3. **Declarative host spec** `docs/tmux-host-config.md` + `docs/tmux.conf.reviewable` —
   the exact tmux.conf content + pinned version the harness needs (single tmux version on
   the host, escape-time/aggressive-resize/history sane values, the fleet-term socket
   contract), written so janet-nix's `modules/home/tmux.nix` can embed it verbatim. Mark
   clearly: NOT APPLIED, spec only.
4. `DECISIONS-N1.2.md` — choices, findings, §0 compliance, test transcript summary.

## Phased order
1. Read ground truth; enumerate current failure-mode behavior (as-is table) into DECISIONS; commit.
2. Integration test suite on the scratch socket; commit.
3. Hardening for gaps the tests exposed; commit.
4. Declarative host spec; commit.
5. Final DECISIONS summary + anything janet-nix needs to know; commit.

## Stack / constraints
Rust tests + tmux 3.4 CLI on a private socket. No new crates. The ttyd/fleet-term container
contract (read-only socket mount, uid 1000) is consumed by N1.7 — coordinate through the
spec file, not by editing tasks/ from this node.
