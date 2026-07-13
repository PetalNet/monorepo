# App shell + dashboard-assistant — build plan (board "before")

Realizes `00-foundations.html` + `00-shell-mock.html` exactly. Bound to CONSOLE-CONTRACTS.md.
The token sheet is ported verbatim into `src/app.css` (AAA values untouched).

## Data-binding layer (`src/lib/api/`)

- `types.ts` — hand-written TS from `console-api/docs/contracts/schemas/**` (no codegen exists).
  Shell-needed: `Principal`, `Me`, `ReadEnvelope<T>`, `Freshness`, `FleetItem`, `HeartbeatItem`,
  `AttentionItem`, `RegistryItem`, `BoxUpdateItem`, `CardItem`, `Emission`/comms, `OpCall`/`OpResult`.
- `client.ts` — the four planes as thin typed reads/calls: `query(POST /query)`, `read(GET /<entity>)`,
  `op(POST /op)`, `emit(POST /emit)`, `bus(WS /bus/ws)`, `library`. `PUBLIC_CONSOLE_DATA_MODE`
  switches `mock` (contract-shaped fixtures, no backend) vs `live`. Never invent a divergent shape;
  a missing contract → BLOCKERS.md + stub against documented shape.
- `derive.ts` — the shared derivations named in foundations §6.4 (computed once, never per-surface):
  `offline` (>90s stale), freshness/staleness per §6.3 windows, severity→label (p0→P0…), attention
  ordering (grade then newest), incident collapse key, "everything is fine" positive-evidence check.
- `mock.ts` — fixtures matching the shell mock's scene (Parker, janet/carson-2, .202/.14/.15/mc34,
  Town Hall empty + a crack variant, mail on the wire, saved dashboards).

## Components (`src/lib/components/`) — decomposed, shared, states as classes

Shell frame: `AppShell` (grid 232px + 1fr; icon-rail ≤1280; single-col ≤1023), `Sidebar`
(brand block, nav from the §2.2 canonical table, footer: user chip + session chip + state line),
`NavItem` (32px, Lucide 16px, active petal-soft, badge graded by severity), `SurfaceSign`
(sign-face title + jade state line + HUD chips, 40px). Assistant: `AskDock` (centered 640px pill /
docked 48px bar / coexist right column; jade presence dot; staged progress; assistant-down state),
`ContextChip` (right-click payload). Primitives from §3.7: `StatusDot`/`StatusPill`, `HudChip`,
`AgentChip` (+hover card), `ActionRow`/`OpButton` (op-named, audit-on-hover, executor-liveness gate),
`Panel` (12px radius, provenance footer, refusal variant), `AttentionCard` (fact-first, fix inline,
blast-radius, ack/snooze), `Envelope` (flying letter + aggregate), `HouseTile`, `Snackbar`,
`Skeleton` (shape-matched), `Dialog`. Cockpit-home: `TownHall`, `FleetRail`, `MailRail`,
`SavedDashboards`, `CrackCard`.

## Routes

`+layout.svelte` (shell frame, fonts, theme, snackbar host, `/` focus + `g`-then-key quick-nav),
`+layout.ts` (load `/me` → session chip + lanes; mock in mock-mode). `/` = Cockpit home (all-clear
state; crack + docked states reachable via a mock scenario switch for board screenshots). Other
surface routes stubbed as honest "curated dashboard" placeholders until their surface PR.

## Design bar (every screen)

Token sheet verbatim; 8pt grid (4/8/16/24/32/48); 2px radius default, 8px controls, 12px panels only;
Lucide only (per-icon imports); em-dash-free copy from the lore pack verbatim; animate every state
change (settle/dock/flip/float/letter/crack per §3.5) with reduced-motion crossfade/none; AAA
measured; borderless (hairline + elevation). Facade honesty: fine line only on positive evidence;
P0 cracks the line, fact-first + fix inline. No op → no button. claim_token never browser-side.

## Gates before PR

`svelte-check` 0/0, root `tsc -b` + `oxlint`/`eslint --max-warnings=0` + `knip` + `vp fmt --check`
green. Screenshots both themes (chromium/firefox/webkit) at 1400 + tablet + phone widths, read as
images. Board-review after. Then PR → codex + adversarial → merge.
