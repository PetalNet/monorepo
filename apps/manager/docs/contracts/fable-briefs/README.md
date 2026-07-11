# FABLE-BRIEFs — Phase 1 harness-rewrite nodes (ready to fire)

_Drafted by Fable overnight 2026-07-10 on branch `feat/N-phase1-briefs` (stacked on
`docs/N0.1-contracts` so every brief can point at `docs/contracts/`). Design-only: no
builds were run, nothing was cloned, nothing pushed. One brief per DAG node; each is
self-contained (§0 unattended rules, mission, LOCKED decisions, local read-first pointers,
reviewable-branch deliverables, phases, stack)._

## Launch matrix

| Node                              | Brief                                               | Class                                             | Repo                    | Burn branch                  | Build weight                        | Gate / prereq                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ----------------------- | ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1.1 Manager supervisor core      | [N1.1](FABLE-BRIEF-N1.1-manager-core.md)            | merge/harden                                      | janet-manager           | `feat/N1.1-manager-core`     | MODERATE (cargo, small deps)        | **⛔ PARKER GREENLIGHT REQUIRED** (runs Janet)                                                                                                                                 |
| N1.2 tmux layer                   | [N1.2](FABLE-BRIEF-N1.2-tmux-layer.md)              | merge/harden                                      | janet-manager           | `feat/N1.2-tmux-layer`       | LIGHT (tests + spec)                | none; janet-nix absent → nix half is spec-only                                                                                                                                 |
| N1.3 Matrix channel features      | [N1.3](FABLE-BRIEF-N1.3-matrix-channel-features.md) | merge/harden                                      | matrix-channel-rs       | `feat/N1.3-channel-features` | **HEAVY** (matrix-rust-sdk)         | none; check for a prior 07-09 burn branch first                                                                                                                                |
| N1.4 Doorman edge+agent           | [N1.4](FABLE-BRIEF-N1.4-doorman.md)                 | merge/harden per DAG; **greenfield on this host** | doorman (**NOT LOCAL**) | `feat/N1.4-edge-agent`       | **HEAVY** (tokio/rustls/yamux/snow) | **launcher must place a PetalNet/doorman checkout at /home/docker/doorman** (else fallback greenfield); needs crates.io egress; Noise NK-vs-XK default = XK, flagged to Parker |
| N1.5 Fleet cockpit + auto-capture | [N1.5](FABLE-BRIEF-N1.5-fleet-cockpit.md)           | merge/harden                                      | tasks                   | `feat/N1.5-fleet-cockpit`    | MODERATE (pnpm, one build)          | none; hook redeploy to 202 is a follow-up step                                                                                                                                 |
| N1.6 tasks Library                | [N1.6](FABLE-BRIEF-N1.6-tasks-library.md)           | **re-port** (stale branch = reference only)       | tasks                   | `feat/N1.6-library-reportv2` | MODERATE                            | none                                                                                                                                                                           |
| N1.7 Web-terminal embed           | [N1.7](FABLE-BRIEF-N1.7-web-terminal.md)            | mixed: harden ttyd embed + **spec** ghostty-web   | tasks                   | `feat/N1.7-web-terminal`     | LIGHT-MODERATE (no docker builds)   | ghostty-web half needs registry egress, else spec-only                                                                                                                         |

## Parallelism plan (max parallel without stepping on each other)

All seven are DAG parallel-group B (no inter-node deps; N0.1 contracts already landed).
The real constraints are **shared checkouts** and **shared RAM**:

- **Checkout collisions:** N1.1+N1.2 share janet-manager; N1.5+N1.6+N1.7 share tasks. Two
  burns must never share one working tree — give each its own `git worktree add` (cheap,
  local) or stagger them.
- **RAM (the .14 constraint):** N1.3 and N1.4 are both heavy cargo compiles. **Never run
  their cold builds simultaneously on .14.** Recommended wave plan:
  - **Wave 1 (fire together):** N1.3 (start its cold build first, it's the long pole),
    N1.5, N1.2, N1.6 (light/moderate, different trees).
  - **Wave 2 (as wave 1 finishes):** N1.4 (after its prereqs land: doorman checkout +
    egress — consider running it on a beefier/other host entirely), N1.7, and N1.1 once
    Parker says go.
- Every burn commits locally to its own new branch; none push; review + merge order is a
  human decision in the morning.

## Open items for the launcher (things only a human/morning can provide)

1. **Parker go/no-go on N1.1** (it touches the code that runs Janet — everything is
   branch-only, but the DAG holds it for his steering).
2. **Doorman checkout** at `/home/docker/doorman` (branches `phase-1-foundation`,
   `phase-2`) + confirm crates.io egress before firing N1.4 — GitHub does not resolve from
   .14 as of drafting.
3. **Noise NK vs XK** answer (contracts open question #1) — N1.4 defaults to XK and
   isolates the choice, so an answer any time before merge is fine.
4. **Registry egress check** for N1.7's ghostty-web half (`pnpm view ghostty-web`); without
   it that half self-descopes to spec-only, which is fine.
5. After N1.5 merges: redeploy the fleet-event hook to 202 (source changes land in
   tasks/mjs; the deployed copy at `/home/agent/.claude/hooks/fleet-event.mjs` on 202 is
   outside this box).

## Drafting decisions (this briefing pass)

| #   | Decision                                                                                                                                                                              | Rationale                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Briefs live on `feat/N-phase1-briefs` stacked on `docs/N0.1-contracts`                                                                                                                | briefs cite `docs/contracts/` paths; stacking keeps those references resolvable on the same branch                                  |
| B2  | Every burn gets its own new branch + per-node `DECISIONS-N1.x.md`; commit-per-phase                                                                                                   | same §0 discipline that made N0.1 reviewable                                                                                        |
| B3  | N1.1 marked HELD FOR PARKER; no other Phase-1 node gated                                                                                                                              | matches the DAG plan exactly ("needs Parker steering (runs Janet)" appears only on N1.1 in Phase 1)                                 |
| B4  | N1.4 written with a hard launcher prereq + a legal greenfield fallback                                                                                                                | repo is GitHub-only and GitHub doesn't resolve here; a brief that can't fire either way would violate never-block                   |
| B5  | N1.4 excludes QUIC (stub the probe interface)                                                                                                                                         | design doc calls QUIC optional/opportunistic; the wss floor is the deliverable; halves the dep tree of the heaviest greenfield node |
| B6  | N1.3 forbids running a second synced client against the live crypto store; offline/handler-level tests + staging checklist instead                                                    | the single-owner lock exists because concurrent crypto clients corrupt the store — a burn must not reproduce the outage it's fixing |
| B7  | N1.6 framed as re-port with a mandatory adopted/superseded/dropped audit table                                                                                                        | DAG says "re-port not merge"; the audit table is what makes a re-port reviewable against the old branch                             |
| B8  | N1.7 splits into ttyd-harden (buildable tonight) + ghostty-web spec (egress-blocked) behind one adapter interface                                                                     | honest about what .14 can actually fetch; the adapter means the replacement burn is a drop-in                                       |
| B9  | Build-budget rules standardized: CARGO_BUILD_JOBS=2 / nice / reuse target/ / one final build; docker + nix builds banned everywhere                                                   | the build host is RAM-tight and runs the live lab services (OOM = the 07-08 postmortem class of incident)                           |
| B10 | All live-data paths (tasks data/, ~/.claude/shared/, live tmux socket, owner locks) declared untouchable in every brief; tests use TASKS_DB_PATH temp DBs / scratch `tmux -L` sockets | the burns run unattended next to live services; the cheapest guardrail is a uniform, explicit one                                   |
