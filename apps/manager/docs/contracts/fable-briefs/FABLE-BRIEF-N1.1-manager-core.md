# FABLE-BRIEF — N1.1: Manager Supervisor Core (harness rewrite, Phase 1)

> **Node class: MERGE/HARDEN** — manager-rs is LIVE and already a faithful, improved port of
> manager.js. This node hardens it and makes it speak the N0.1 contracts. Do NOT rewrite it.
>
> **⛔ HELD FOR PARKER — do not fire this brief without his explicit greenlight.** This code
> runs Janet herself (DAG plan: "needs Parker steering (runs Janet)"). Everything is
> branch-only and reviewable, but Parker gates the burn itself.
>
> **Build weight: MODERATE** — Rust, small dep tree (serde/ureq/chrono/uuid/libc), builds via
> the dream2nix flake. Budget one `cargo build` + test cycle, parallelism-capped.

## §0 — How to work (fully autonomous, unattended, no human mid-run)

- You are **Fable**, running alone. This brief is the source of truth. Never block: where it
  leaves a choice, pick the simplest defensible option and log it with a one-line rationale
  in `docs/contracts/fable-briefs/DECISIONS-N1.1.md` on your branch.
- Repo: `/home/docker/janet-manager`. New branch **`feat/N1.1-manager-core`**, branched from
  the tip of `feat/N-phase1-briefs` (so `docs/contracts/` is present). Commit locally per
  phase; do NOT push; do NOT open a PR.
- **REVIEWABLE-ONLY**: change no live config, restart no service, touch no running binary,
  never write under `~/.claude/shared/` (the live state/heartbeat files). The live manager
  keeps running untouched; your work is judged from the branch.
- **Build budget (RAM-tight shared host):** compile with `CARGO_BUILD_JOBS=2` and
  `nice -n19`, prefer `cargo check` + `cargo test` over repeated full builds, and NEVER run
  `nixos-rebuild` or `nix build` of the full flake unless a plain cargo build has already
  succeeded once. If the box is visibly loaded (load average > cores), wait, don't pile on.
- GitHub does NOT resolve from this host. Everything you need is local; if a dependency
  fetch fails, vendor from the existing `Cargo.lock`/`target/` state and log it.

## Mission

Make the live Rust manager the **contract-compliant supervisor core** of the rewritten
harness: emit the v2 heartbeat (with `schema_version`, `handle`, `channel_lock`), validate
config against the canonical schema semantics, keep every existing supervision behavior
(spawn/resume, adopt, stable-pane ownership, crash backoff, rate-limit wait, healthcheck,
!command loop) bit-for-bit unless a contract says otherwise, and cover the state machine
with tests so the N2.x control-plane work can build on it without fear.

## LOCKED decisions (do not relitigate)

- Contracts live in `docs/contracts/schemas/` (N0.1) and are the source of truth for shapes.
  Heartbeat v2 = key rename `schema`→`schema_version` (const 2) + optional `handle` +
  optional `channel_lock`. Session-state keeps camelCase `sessionId` (manager.js rollback).
- Stable-pane ownership (pane id + `@agent_manager_owner` user option) is regression
  history — never target the active pane, never pane 0, never session-name liveness.
- First boot of a fresh session id uses `--session-id`, subsequent boots `--resume`.
- Slash allowlist stays exactly `/compact /context /cost /status` — NEVER add /model,
  /config, /fast (they hang the agent's own session; janet-model-swap-footgun).
- Supervision must never block on Matrix I/O (channels + sender/sync threads stay).
- The manager is publish-agnostic: nothing host-specific compiled in; config carries it all.
- OS-neutral contracts: tmux fields are nullable in the heartbeat; don't make new POSIX
  assumptions in shapes (Windows box agents are Phase-2, but the contract is now).

## Read first (ground truth, all local)

- `manager-rs/src/supervisor.rs` — the state machine (tick loop, spawn/adopt, crash
  backoff, rate-limit resume, command handling). The port-notes comments flag every
  deliberate delta from manager.js; preserve them.
- `manager-rs/src/state.rs` — SessionState + Heartbeat (v1, key `schema: 1`) + atomic write.
- `manager-rs/src/config.rs` — RawConfig (deny_unknown_fields) → Config; `config.example.json`.
- `manager-rs/src/health.rs` — healthcheck asserts; `RUNBOOK-canary-deploy.md` +
  `FABLE-SPEC-canary-deploy.md` — what the canary flow expects from the heartbeat.
- `manager-rs/src/matrix.rs`, `manager-rs/src/tmux.rs` — I/O layers (N1.2 owns tmux
  internals; you consume its API).
- `manager.js` (repo root) — the JS baseline, for parity questions only.
- `docs/contracts/CONTRACTS.md` + `schemas/session-state.schema.json` +
  `schemas/manager-config.schema.json` — the contracts this node implements.
- `docs/contracts/DECISIONS.md` — open question #3 (heartbeat rename transition). Default
  (pick-and-log): manager + healthcheck ship as one binary, so NO dual-key transition
  window is needed; write `schema_version: 2` only, and update health.rs in the same commit.

## Deliverables (branch `feat/N1.1-manager-core`, local commits only)

1. **Heartbeat v2**: `state.rs::Heartbeat` renamed field (`schema_version = 2`), new
   optional `handle` (from config `agent_name`), new optional `channel_lock` (stub state
   `held` until N1.3/N2.2 wires the real matrix-channel lock through — log the stub).
   `health.rs` reads v2 AND tolerates a v1 file (`schema: 1`) with a deprecation note, so a
   healthcheck binary deployed before the manager flips never hard-fails on shape.
2. **Config schema conformance test**: a unit test that deserializes
   `config.example.json` through RawConfig and asserts the canonical schema's required set
   {creds_path, control_room} + deny-unknown behavior (a typo'd key must error). Accept the
   optional `schema_version` key (const 1) — add the field to RawConfig, ignored.
3. **State-machine tests**: table-driven unit tests for `handle_exit` (rate-limit path,
   quick-crash backoff doubling, MAX_CRASHES stop, stopped-state rate-limit-reset clearing)
   and `check_rate_limit_hook_file` parsing (RFC3339 / epoch secs / epoch millis / garbage).
   Refactor ONLY as far as testability requires (e.g. extract pure functions); no redesign.
4. **Session-state conformance**: load/save round-trip test incl. legacy file without
   `bootstrapped`/`schema_version` (defaults true / version 1).
5. `DECISIONS-N1.1.md` — every choice + a §0-compliance statement + build/test log summary.
6. Green: `cargo check`, `cargo test`, one `cargo build --release` (capped parallelism).
   Do NOT install, symlink, or restart anything.

## Phased order

1. Read all ground truth; write findings + plan to DECISIONS-N1.1.md; commit.
2. Heartbeat v2 + health.rs dual-read; commit.
3. Config + session-state conformance (incl. schema_version fields); commit.
4. State-machine tests (+ minimal extraction refactors); commit.
5. Full test/build pass; final DECISIONS summary + open questions for Parker; commit.

## Stack / constraints

Rust (edition per Cargo.toml), serde/ureq/chrono/uuid, dream2nix flake already
build-verified (commit 8c7b9df). No new heavy deps — if you feel the need for a crate not
already in Cargo.lock, you're over-scoping (JSON Schema validation in-process is NOT
required; conformance = serde behavior tests). The live binary and its unit stay untouched.
