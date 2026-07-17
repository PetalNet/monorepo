# SOL UNIFY TASK — one SvelteKit full-stack Lab Console

You are **Sol (gpt-5.6-sol)**, an autonomous build agent. This is a **large migration**: unify the
Lab Console into ONE SvelteKit full-stack application. Scope it, sequence it sensibly, and report
progress as you go. Work to completion; do not stop mid-way to ask permission for steps this spec
already authorizes.

**Worktree:** `/home/docker/console-feat/greenfield` (you are already `-C`'d here)
**Branch:** `feat/console-greenfield` — continue from HEAD, keep committing here.
**Git identity:** run `git config user.name "Janet"; git config user.email "returnsvoidjanet@gmail.com"`.
**Decision owner:** Eli (the stack owner). This spec is his direction. Janet + Eli review the PR.

---

## 0. The decision in one sentence

The console currently ships as **two apps** — `apps/console` (SvelteKit UI, freshly re-scaffolded,
~579 LOC) and `apps/console-api` (a standalone Fastify Node gateway, ~17.7k LOC). **Eli's decision:
fold `console-api` INTO the SvelteKit server so there is ONE full-stack app.** Everything the gateway
did now lives inside the SvelteKit server process, modeled in Effect, and exposed through three
surfaces derived from one set of domain services.

This **supersedes** `apps/console-api/docs/ADR-GATEWAY-SERVICE.md` (which declares console-api a
separate Node/Fastify service with its own deployment/failure boundary). You MUST update that ADR:
mark it **Superseded**, and either replace it with — or add — a new ADR (`docs/adr/` in the console
app or alongside the old one) titled something like **"Unified SvelteKit console substrate"** that
records: everything runs in the SvelteKit server; the three surfaces (remote functions, REST+OpenAPI,
MCP) derive from one Effect domain layer; the WebSocket bus runs via a custom Node server wrapper.
Keep the adapter-boundary table (Manager / control-plane / box-agent / tracker / Library / bridge
remain authoritative — the console still reads/projects/dispatches, it does not become a second
writer). What changes is only the _packaging_: those adapters + the lake/bus/projector/assistant/etc.
now live in the SvelteKit server, not a separate Fastify process.

---

## 1. KEEP — do not revert the recent greenfield work

The current `feat/console-greenfield` HEAD contains review fixes that are CORRECT. **Keep all of them.**
Do NOT revert, and build on top of these patterns:

- The **effect-db migration** (DB layer via `effect-db` / `@effect/sql-pg`, `src/lib/server/db/`).
- The **light/dark themes** (two DaisyUI themes named `light` and `dark`, split theme files) and the
  `ThemeToggle.svelte` component. **EXCEPTION / Eli correction:** the current change wired the toggle
  with `runed`'s `PersistedState` — **replace that with `mode-watcher`**
  (https://github.com/svecosystem/mode-watcher, from svecosystem), the dedicated Svelte
  light/dark/system mode library that handles localStorage + FOUC + SSR natively. As part of the
  unify, **swap `ThemeToggle` from `runed` `PersistedState` to `mode-watcher`**, keeping the two
  DaisyUI themes named `light` / `dark`. Do not keep the runed persisted-state theme approach.
- The **`status.remote` canonical + delegate** pattern: canonical logic lives once as an Effect,
  exposed as a SvelteKit **remote query** (`status.remote.ts`) AND re-used by the REST endpoint
  (`routes/api/v1/status/+server.ts`). This is the template for every surface below.
- **OTEL / observability** instrumentation, Sentry/Glitchtip reporting.
- The **Effect-at-the-shell** discipline (runners `runPromise`/`runSync`/`runFork` only at the
  program edges; inner code returns Effects), the **SER `handler`** usage at request boundaries,
  and the **better-auth-effect-qb-adapter** (config-lookup eslint, not svelte-specific).
- The auth spine: better-auth + Authentik OIDC, first-run-admin, tier inheritance, the auth-gate
  policy. Do not regress it.

Grounding reads before you touch handlers/effects:

- The SER handler docs — WebFetch **https://barekey.dev/docs/ser/handler** (central to the
  request-boundary pattern; use SER's `handler`, don't hand-roll request→build-Effect→run→shape).
- Current pattern files: `apps/console/src/routes/status.remote.ts`,
  `apps/console/src/routes/api/v1/status/+server.ts`, `apps/console/src/lib/server/console/service.ts`,
  `apps/console/src/lib/server/runtime/layer.ts`, `apps/console/src/lib/server/db/`.

---

## 2. BRING BACK — the deleted console UI

The commit `b06601d feat(console): build greenfield SvelteKit foundation` **deleted the entire prior
console UI** when it reset the app to a bare foundation. Restore/port it. The prior full UI is in git
at **`b06601d^`** — read any file with `git show b06601d^:<path>`. Port it forward onto the current
server pattern (§1 + §3): rewire each surface's data access to the folded-in Effect domain services
via **remote functions** (the `status.remote` template), NOT the old separate-HTTP-client
(`lib/api/client.ts`) or the mock data layer. Hold the **/impeccable + eli-design-mode** bar on every
surface (Material-3, borderless surfaces = hairline rules + elevation, Lucide icons only — no emoji,
DaisyUI custom themes light+dark, AAA contrast measured, 8pt grid, small shared components).

**Design reference** (pixel-match intent): the 12 surface specs + mocks at
`/home/docker/console-fable/specs/src/` (`00-foundations`..`12-cost`, each with a `*-mock.html`),
and the already-built reference implementation at
`/home/docker/frontend-fable/monorepo/apps/console/src/routes/` (surfaces built to those specs — use
as a visual/structural reference, but the source of truth for THIS port is `b06601d^` + the specs).
Bind every surface to REAL contract data per
`apps/console-api/docs/contracts/CONSOLE-CONTRACTS.md`.

### Routes to restore (from `b06601d^:apps/console/src/routes/`)

- `/` — **Cockpit / dashboard** (`+page.svelte`, `cockpit.remote.ts`; `caught-failures.contract.spec.ts`)
- `/agents` — **Agents & managers** (`+page.svelte`, `+page.ts`, `CommsLog.svelte`,
  `comms.remote.ts`, `terminal-peek.remote.ts`)
- `/observability` — **Observability** (`+page.svelte`, `+page.ts`, `InvestigationGraph.svelte`,
  `investigations.remote.ts`)
- `/signals` — **Signals / bus** (`+page.svelte`, `+page.ts`, `DeliveryPane.svelte`,
  `delivery.remote.ts`, `source-modes.remote.ts`, `storms.remote.ts`)
- `/work` — **Work / tasks** (`+page.svelte`, `+page.ts`, `wanted-board.remote.ts`)
- `/library` + `/library/[itemId]` — **Library** (`+page.svelte`, `+page.ts`,
  `library-manager.remote.ts`; detail: `[itemId]/+page.svelte`, `[itemId]/+page.ts`,
  `[itemId]/library-detail.remote.ts`)
- `/hosts` — **Hosts** (`+page.svelte`, `+page.ts`, `availability.remote.ts`)
- `/network` — **Network key-ceremony** (`+page.svelte`, `+page.ts`, `CeremonyCard.svelte`,
  `ceremony.remote.ts`)
- `/updates` — **Updates / notifications & approvals** (`+page.svelte`, `+page.ts`,
  `approvals.remote.ts`) — this is also the home of surface **11-notifications**.
- `/terminal` — **Terminal / PTY** (`+error.svelte`, `+page.server.ts`, `+page.svelte`) — needs the
  WS bus / streaming (see §3 WS caveat).
- `/cost` — **Cost comparison** (`+page.svelte`, `+page.ts`)
- `/login` — already exists in greenfield; keep the current one.
- `+layout.svelte` / `+layout.server.ts` — restore the app shell (nav rail, command palette, ask
  dock, snackbar) — see components below.

### Component library to restore (from `b06601d^:apps/console/src/lib/components/`)

AgentPresence, AppShell, ApplyModeChip, AskDock, AttentionCard, AvailabilityPanel, AvailabilityRow,
BudgetLight, CockpitSkeleton, CommandPalette, CostComparisonPanel, Countdown, Envelope, FleetStrip,
HostCard, HouseTile, HudChip, Icon, IconButton, LibraryGraphView, LibraryItemCard, LibraryKanbanView,
LibraryManagerSession, LibraryViewSwitcher, ModalSurface, OpButton, PTYView, Panel, PriorityPips,
RailCard, RosterRow, SavedDashboards, SegmentedControl, SettleRow, Sidebar, Snackbar, StatusDot,
StatusPill, SurfaceSign, TownHall, UpdateRow, VerificationBadge, plus `icons.ts` and the test files
(`interaction-targets.test.ts`, `modal-surface.test.ts`, `motion-contract.test.ts`).

### Supporting lib to restore/port (from `b06601d^:apps/console/src/lib/`)

`stores/clock.svelte.ts`, `stores/snackbar.svelte.ts`, `nav.ts`, `util.ts`,
`cockpit-geometry.ts`, `command-palette.remote.ts`, the `data/*` view-logic modules
(`agents`, `availability`, `cockpit`, `cost`, `delivery-health`, `hosts`, `investigations`,
`library`, `library-views`, `network`, `observability`, `palette`, `signals`, `terminal`, `updates`,
`work`, `work-settlement`, plus their tests). **Port the DATA-SHAPING/view logic; replace the mock
and separate-HTTP-client data SOURCES with reads from the folded-in Effect services via remote
functions.** `lib/data/mock.ts` may stay only as test fixtures/storybook, never as a live source.
`lib/api/client.ts` (the old cross-process HTTP client) should be **eliminated** — the UI now calls
the in-process server directly through remote functions. Fix at root per KNIP (see §4); do not leave
a dangling HTTP client just to satisfy old imports.

---

## 3. FOLD — console-api into the SvelteKit server (the core migration)

Move everything `apps/console-api/src/` does into the SvelteKit server. **Eli's exact pattern:**

> "Model them in effect to keep them agnostic, wrap them in remote functions for the UI's RPC and
> expose an API (with an OpenAPI) and an MCP from the effects as well."

So the shape is: **ONE set of Effect domain services (transport-agnostic)** → **THREE surfaces
derived from them.**

### 3a. One Effect domain layer (agnostic core)

Port these `console-api/src/` subsystems into `apps/console/src/lib/server/**` as Effect services
(Context.Service + Layer, composed into `ServerLayer`), keeping them free of any HTTP/Fastify/WS
transport concerns:

- **Event lake + ordered bus + appender + projector**: `bus/appender.ts`, `bus/broker.ts`,
  `bus/replay.ts`, `projector/index.ts`, `emission.ts`, `dashboard/store.ts`.
- **Ingest**: `ingest/authz.ts`, `ingest/fingerprint.ts`, `ingest/registrations.ts`,
  `ingest/scrubber.ts` (secret scrubbing stays a release gate).
- **EdgeEventService / attention**: `attention/cracks.ts` and the edge-session/edge-registry
  contract paths.
- **Assistant runtime**: `assistant/compiler.ts`, `assistant/engine.ts`, `assistant/runtime.ts`,
  `assistant/tools.ts`.
- **Cost**: `cost/compare.ts`, `cost/meter.ts`, `cost/service.ts`.
- **Notifications + Matrix**: `notifications/delivery.ts`, `notifications/matrix.ts`.
- **Registry**: `registry/acquisition.ts`, `registry/contribution.ts`, `registry/loader.ts`;
  `semantic/embedding.ts`, `semantic/registry.ts`, `semantic/search.ts`; `palette/search.ts`.
- **Network key-ceremony**: `network/key-ceremony.ts`.
- **Signals**: `signals/source-modes.ts`, `signals/storm.ts`.
- **Tracker reads + commands**: `reads/tracker*.ts`, `commands/tracker.ts`, and the other
  `reads/*` (comms, entities, roster, routes, work-settlement).
- **Query planes**: `query/branch.ts`, `query/history.ts`, `query/structured.ts`; `render/*`.
- **Availability**: `availability/service.ts`.
- **The 3-role RLS DB layer**: `db/pool.ts` (`withScopes`), `db/migrate.ts`, `db/seed.ts`, and the
  migrations under `apps/console-api/migrations/` — reconcile with the greenfield `effect-db` DB
  layer (`apps/console/src/lib/server/db/`). ONE DB layer, RLS/3-role scoping preserved, driven by
  effect-db migrations. Do not run two competing DB stacks.
- **Auth/principal/scope/grants/proposals/tiers**: `auth/*`, `scope.ts` — reconcile with the
  console's existing better-auth spine (§1). Principal resolution + ReBAC/RLS enforcement remain at
  the request boundary. Do not duplicate the auth spine; unify it.
- **Bridge**: `bridge/index.ts`, `bridge/system-outbox.ts`, `bridge/uuid5.ts`.
- The CLI `bin/*` (acquire-capability, bridge, mint-token, seed) → port to server-side scripts /
  package bin as appropriate.

Contracts (`apps/console-api/docs/contracts/` — `CONSOLE-CONTRACTS.md`, `ops.json`, JSON schemas)
remain the language-neutral boundary; keep them the source of truth for the surfaces.

### 3b. Three surfaces from the one core

1. **SvelteKit remote functions** — the UI's RPC. Every UI surface (§2) reads/writes through
   `*.remote.ts` remote queries/commands that call the Effect services. Follow the `status.remote`
   canonical template.
2. **REST API + OpenAPI** — under `apps/console/src/routes/api/v1/**` (`+server.ts` endpoints, the
   versioned HTTP surface from CONSOLE-CONTRACTS §1.1: Query / Command / Bus / Library planes,
   assistant, cost, grants, tiers, ceremony, ingest, etc.). Each endpoint runs the SAME Effect as
   the matching remote function (canonical-logic-once, like `status`). **Emit an OpenAPI spec**
   generated from the Effect service schemas (the JSON schemas already exist under
   `docs/contracts/schemas/` — derive/validate the OpenAPI against them). Serve the OpenAPI doc
   (e.g. `/api/v1/openapi.json`).
3. **MCP server** — expose the same Effect operations as an MCP surface (the assistant already has
   an MCP handler: `assistant/tools.ts` `handleAssistantMcp`). Derive the MCP tool set from the
   Effect services so it stays in lockstep with the REST/RPC surfaces. Decide + document how it's
   served (in-process MCP endpoint / stdio bin) in the new ADR.

### 3c. WebSocket bus caveat (READ THIS)

`@sveltejs/adapter-node` has **no WebSocket upgrade hook** — you cannot serve the bus WS purely
from SvelteKit request handlers. The bus (`bus/broker.ts` subscribe/fan-out, terminal PTY streaming,
signals live feed) needs a **custom Node server wrapper**: a small Node entry that (a) creates the
HTTP server, (b) mounts the SvelteKit handler (from `build/handler.js` in prod, and via a Vite dev
plugin in dev), and (c) attaches a `ws` upgrade listener that bridges into the Effect bus broker.
Preserve subscription fencing / ordered delivery from `bus/broker.ts`. Document the dev + prod story
(the custom server, how `pnpm dev` and the built artifact both get WS) in the ADR. This is the one
place the "everything in SvelteKit" rule needs an explicit escape hatch — make it clean and
first-class, not a hack.

---

## 4. STANDING RULES (non-negotiable)

- **KNIP IS ALWAYS RIGHT.** Fix at the root — real dep/config/export fixes, **zero suppressions**
  (no `ignore`, `ignoreDependencies`, `ignoreUnresolved`, `ignoreBinaries`, no inline disables to
  dodge knip). If knip flags something, the code/config is wrong, not knip.
- **Effect stack** end-to-end: services as Effects, runners only at the shell (§1), SER `handler`
  at request boundaries.
- **/impeccable + eli-design-mode** on every UI surface (Material-3, borderless, Lucide-only,
  DaisyUI light+dark, AAA contrast measured, 8pt grid, small shared components). No emoji in UI.
- **No facades, no fake data in live paths.** Drive the real path; bind to real contract data.
- **Gates green — report REAL exit codes + counts** for: `pnpm check`, `pnpm lint`,
  `pnpm lint:knip` (and `knip:prod` if present), `pnpm build`, `pnpm test` (incl the testcontainers
  adapter-conformance + any contract specs), **plus the repo CI gates**: the dedupe check,
  `manypkg` check, and `typesync` (run them the way CI does — check the root `package.json` scripts
  and `.github/workflows/`). Fix at root until all are 0.
- **Self-review each phase**: shell out to
  `codex exec -m gpt-5.6-terra --dangerously-bypass-approvals-and-sandbox -C /home/docker/console-feat/greenfield "<review request>"`,
  apply findings.
- **Commit to `feat/console-greenfield`** as Janet, incrementally, with clear messages. **Push, open
  / update the PR, but do NOT merge** — Janet + Eli review and cut over.
- **Shared host** (`.14`): other agents run alongside. Run `free -g` before heavy pnpm/vite builds;
  never OOM (~2–3 concurrent builds is the host ceiling). Reuse the CI build-DB env trick that HEAD
  already used for `pnpm build` if a Postgres URL is needed at build time; tear it down after.

---

## 5. Sequencing (suggested — you own the ordering, keep gates green each step)

This is large. Sequence sensibly and report progress after each phase. A sane order:

1. **Fold the DB layer + core lake/bus/projector Effect services** into `lib/server`, unify with the
   effect-db + auth spine. Keep `status` working. Gates green.
2. **Stand up the three-surface scaffolding** on one real domain (e.g. roster/agents reads): Effect
   service → remote fn + REST `+server.ts` + OpenAPI entry + MCP tool. Prove the pattern end-to-end.
3. **Custom Node server + WS bus wrapper.** Prove subscribe/fan-out + terminal PTY.
4. **Bring back UI surfaces** one at a time (cockpit → agents → hosts → observability → signals →
   work → library → network → updates/notifications → terminal → cost), each wired to its folded-in
   service via remote functions, each holding the design bar, each with gates green + self-review.
5. **Fold remaining services** (assistant, cost, notifications+Matrix, registry/semantic,
   key-ceremony, ingest, bridge, tracker commands) behind their surfaces.
6. **Retire `apps/console-api`** as a separate app once everything is folded in and green (remove it
   from `pnpm-workspace.yaml` / delete the app, or reduce it to the contracts dir if the contracts
   should live there — your call, but no dead second app, no knip suppressions to hide it). Update
   the ADR (§0). Final full-gate run + self-review.
7. Update the PR. Post a progress summary. **Do NOT merge.**

Report progress to the log as you go (phase done + gate exit codes). When finished (or if genuinely
blocked on something this spec doesn't cover), print a clear `SOL UNIFY DONE` /
`SOL UNIFY BLOCKED ON <x>` line with the PR URL and the final gate exit codes + counts.
