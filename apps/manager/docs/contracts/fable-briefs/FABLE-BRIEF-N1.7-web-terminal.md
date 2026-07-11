# FABLE-BRIEF — N1.7: tasks Web-Terminal Embed (harness rewrite, Phase 1)

> **Node class: MIXED — harden the shipped ttyd embed (merge/harden), and SPEC the
> ghostty-web replacement (greenfield, likely BLOCKED on network).** Existing pieces:
> `fleet-term/Dockerfile` (pinned ttyd 1.7.7 + sha256, host-socket mount, container-only
> binding), `docker-compose.fleet-term.yml`, and WIP branch `feat/fleet-terminal`
> (68531ca: audit route + mock-sessions). Tracker: 547 (review), 591 (inbox).
>
> **Build weight: LIGHT-MODERATE** for the harden half (Node/SvelteKit tests + one build;
> do NOT docker-build the ttyd image — the Dockerfile needs GitHub, which doesn't resolve).
> The ghostty-web half needs npm-registry/GitHub egress for new packages — **verify
> `pnpm view ghostty-web` resolves before scoping it in; if it doesn't (expected on .14),
> that half stays SPEC-ONLY tonight.** No Parker gate, but Eli owns the container-isolation
> stance — respect it absolutely.

## §0 — How to work (fully autonomous, unattended, no human mid-run)

- You are **Fable**, running alone. Brief = source of truth. Pick-and-log free choices into
  `DECISIONS-N1.7.md` at the tasks repo root on your branch; never block.
- Repo: `/home/docker/tasks`. New branch **`feat/N1.7-web-terminal`** from `main`, pulling
  in the useful parts of `feat/fleet-terminal` via `git show`/cherry-pick-with-review (it's
  WIP — audit each hunk, don't bulk-merge). Commit locally per phase; do NOT push; no PR.
- **REVIEWABLE-ONLY**: live app + live tmux. Do NOT restart containers, do NOT
  docker-compose up anything on the fleet network, do NOT attach anything new to the LIVE
  tmux socket. Runtime testing of terminal plumbing uses a scratch tmux server on a
  private socket (`tmux -L n17test`) and the existing mock-sessions approach from the WIP
  branch. Do NOT write to `data/`; temp DB via `TASKS_DB_PATH` for tests.
- **Build budget:** vitest freely; ONE niced `pnpm build`. No docker builds. No new deps
  without a logged registry-resolution check.

## Mission

Ship the reviewable v1 of the embedded fleet terminal: the tasks UI shows a live (or
read-only mirrored) agent session per fleet-cockpit row, gated by RBAC, with the ttyd
container as the transport (hardened per Eli's isolation rules) — plus the honest,
evidence-based migration spec for replacing ttyd with an owned ghostty-web stack (task 591) including glyph-atlas font handling, so the replacement burn can fire the moment
egress is available.

## LOCKED decisions (do not relitigate)

- **Container isolation (Eli):** the terminal bridge binds INSIDE the docker network only —
  never host-localhost, never a public interface; no SSRF surface from host processes. The
  host tmux socket mounts read-only wherever ttyd runs in mirror mode.
- **Supply-chain pinning:** ttyd stays pinned to an exact release + sha256 (never
  releases/latest). Same rule applies to any ghostty-web artifact in the spec.
- **RBAC before pixels:** no terminal iframe/websocket reaches the browser without an
  authenticated, authorized user (Authentik header identity, same `me` the tasks app
  already trusts); default is DENY; read-only mirror is the default capability and
  write/interactive access is a separately-gated permission (per-user, logged).
- **Stable-pane respect:** anything that attaches to the live janet session is VIEW-ONLY
  (`tmux attach -r` semantics / capture-pane mirroring). Nothing in this node may ever
  send keys to a pane tagged `@agent_manager_owner` — interactive access targets
  human/scratch sessions only. (Ownership contract: janet-manager `manager-rs/src/tmux.rs`.)
- Replace-ttyd direction is locked (591): the end state is an owned web-terminal stack
  (ghostty-web named in the DAG); ttyd is the transitional transport, so build the UI
  against a thin adapter interface, not against ttyd specifics.
- Audit trail: session-view opens/closes and any interactive grant are logged (the WIP
  branch's audit route is the seed).

## Read first (ground truth, all local)

- `fleet-term/Dockerfile` + `docker-compose.fleet-term.yml` — the shipped transport and
  its isolation posture (read the header comments; they encode Eli's rules).
- `git -C /home/docker/tasks show 68531ca` (WIP: fleet-terminal audit route + prosemark
  render + mock-sessions) and `git diff main...feat/fleet-terminal --stat` — inventory
  what's reusable; the mock-sessions harness is how you test without live attach.
- `src/routes/fleet/` — where the terminal drill-in lands; `src/lib/server/fleet.js` —
  per-agent rows to hang it off; hooks/layout for Authentik identity (`+layout.server.js`,
  how `me` is derived).
- `/home/docker/janet-manager/manager-rs/src/tmux.rs` — pane-ownership rules you must not
  violate; `/home/docker/tasks/tmux-mobile-report.md` + gallery `tmux-mobile-report-…` —
  prior art notes on mobile terminal UX.
- Tracker 547 (review — read comments for what review flagged) + 591 (inbox — the
  replace-ttyd mandate), read-only via sqlite3.
- DAG plan N1.7 line (ghostty-web, RBAC, glyph-atlas fonts).

## Deliverables (branch `feat/N1.7-web-terminal`, local commits only)

1. **Terminal panel v1** in the fleet cockpit: per-agent "view session" → RBAC-gated page
   embedding the ttyd stream via an adapter module (`src/lib/server/term-adapter.js`:
   interface {openView(agent, me), grantInteractive(agent, me), close(...)}, ttyd impl
   behind it). Mock-sessions-backed tests for the RBAC deny-by-default matrix (anon /
   viewer / operator) and the audit log entries.
2. **Isolation conformance**: a test/static-check asserting the compose service publishes
   no host ports and the socket mount is `:ro` in mirror mode (parse the compose YAML —
   guards regression of Eli's rules by review-time evidence, not trust).
3. **View-only enforcement**: the adapter's mirror path structurally cannot transmit
   keystrokes (ttyd launched read-only / `-W` off; assert the command line in tests).
   Interactive grants spawn against scratch/human sessions only — a denylist test that a
   target session/pane carrying the manager tag is refused.
4. **ghostty-web migration spec** (`docs/web-terminal-ghostty.md`): component inventory
   (server pty bridge, wasm/canvas renderer, glyph-atlas font pipeline — which fonts, how
   atlased, fallback), the adapter mapping (same interface as #1), pinning/vendoring plan
   (exact artifacts + hashes, given no-egress constraints), RBAC/isolation parity
   checklist, and an honest effort estimate. If the registry resolves and the packages are
   small, a spike behind the adapter is allowed — pick-and-log; otherwise spec-only.
5. Tests green + ONE `pnpm build`; `DECISIONS-N1.7.md` — WIP-branch hunk audit
   (adopted/dropped per hunk), choices, §0 compliance, egress-blocked items for the launcher.

## Phased order

1. Inventory WIP branch + shipped transport; hunk audit + plan → DECISIONS; commit.
2. Adapter + RBAC + audit trail + tests (mock sessions); commit.
3. Isolation + view-only conformance tests; commit.
4. Cockpit UI panel; commit.
5. ghostty-web spec (+ optional spike if egress allows); commit.
6. Build pass; final DECISIONS; commit.

## Stack / constraints

SvelteKit + the existing fleet-term container (unbuilt tonight — treat the image as
given), scratch tmux for tests, Authentik-derived identity. No new deps without a logged
resolution check. The live janet session is sacred: view-only, and only through the
read-only socket mount.
