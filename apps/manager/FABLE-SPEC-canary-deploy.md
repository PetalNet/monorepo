# Spec: agent-manager in the monorepo + Scout-canary deploy (task-561)

STATUS: HELD — do not implement until Parker's explicit go (Fable burns are gated).

## Goal

The agent manager becomes a publishable package in `PetalNet/monorepo`, deployed through a
Scout-first canary pipeline with healthcheck-gated promotion and auto-revert. Janet never
boots a bad manager; Scout takes the hit.

## Repo split (Parker, 2026-07-02)

- `Monorepo/apps/agent-manager/` — ALL manager code. Publish-agnostic: zero lab paths,
  hostnames, room ids, tokens, or usernames in the source. Everything host-specific arrives
  via a single config file whose path is given by env (`AGENT_MANAGER_CONFIG`).
- `janet-manager` repo (this repo) — local config + infra only: the config files for each
  deploy target, systemd unit, vault references, deploy inventory. This is the IaC baseline;
  it never contains manager logic.

## Deliverables

1. **Extract** `/home/docker/janet-manager/manager.js` into `Monorepo/apps/agent-manager`
   (pnpm workspace member, deps via catalogs, monorepo lint/knip clean). Behavior-preserving
   refactor: every literal that is lab-specific moves to config; the current pane-pinning fix
   (window 0 / pane 0, see manager.js comment) survives as configurable behavior.
2. **Versioned releases.** A release = monorepo git sha + built artifact. The deploy tool
   records per-target `current` and `last-good` versions (state lives in janet-manager repo
   or on the target host, not in the monorepo).
3. **Deploy CLI** (`tools/` or inside the app): `deploy <target> <version>`, targets defined
   in an inventory file in janet-manager (Scout = scout-pc over ssh; Janet = local .14).
4. **Healthcheck** — three asserts, not just process-up:
   - process alive under its supervisor;
   - agent connected to Matrix (channel heartbeat / sync active);
   - agent responsive: answers a ping message within a timeout.
5. **Canary flow** (`deploy --canary <version>`): deploy to Scout → healthcheck window →
   pass ⇒ promote to Janet; fail ⇒ NO promote + roll Scout back to `last-good` + alert
   (shawn-send). After promoting to Janet, run the SAME healthcheck on Janet and auto-revert
   Janet to `last-good` on failure — .14-specific breakage won't show on Scout's box.
6. **PARCS checkin de-tmux** — rewrite `~/.claude/bin/parcs-checkin.sh` (and its teardown
   variant) to deliver the checkin prompt via `system-enqueue` (outbox → E2EE daemon →
   System room → wakes Janet) instead of `tmux send-keys`. Keep the modes (routine/july4),
   hour logic, logging, and the session-absent fallback alert. tmux disappears from the
   script entirely.

## Constraints

- pnpm only; deps actually used (no facade output — grep-verify).
- No secrets in either repo: tokens fetched at runtime from vault or env.
- Rollback must work when the new manager is too broken to talk: driven from outside the
  target process (deploy host over ssh / local supervisor), not from inside the manager.
- Manager restarts blip Matrix; promotion to Janet is one deliberate restart, never a loop.

## Acceptance (end-to-end, drive the real path)

- Bad release (deliberately broken build) → Scout fails healthcheck → Scout auto-reverts to
  last-good and comes back healthy → Janet untouched → alert fired.
- Good release → Scout passes → promote → Janet passes post-promote healthcheck → both on
  new version; `last-good` advanced.
- PARCS checkin fires from cron with no tmux session present at all and the prompt arrives
  via the System room.
