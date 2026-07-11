# Point Flutter client — build rules (pinned)

The client's design is **LOCKED**: `../docs/design/UI-SPEC-FINAL.md` (authoritative) +
`../docs/design/design-direction.md` (rationale). Build to **match the mockup**
(`../docs/design/mockups.final.html`) pixel-close via the render→screenshot→fix loop
(`../docs/design/flutter-playbook.md`). Do not relitigate locked decisions.

## Non-negotiables
- **Flutter 3.44.6 / Dart 3.12** (pinned via the repo `rust-toolchain`-equivalent expectation;
  the CI uses `subosito/flutter-action` stable). **Zero `flutter analyze` warnings** is a gate —
  run it before you look at pixels.
- **State: Riverpod** (`hooks_riverpod`). Leaf-local ephemeral state may use `setState`; shared
  state is Riverpod. No other state library.
- **Router: kaisel `0.22.0`, PINNED** in `pubspec.yaml`/`pubspec.lock`. Do NOT `pub upgrade` it.
  Acceptance bar: an **animated adaptive branched shell** (animates between branches, never a hard
  `IndexedStack` cut) and **auth changes must NOT reset the router/shell** (login page lives
  OUTSIDE the shell; guards use stack-as-state + `router.set`, not auto-rerunning rebuilds).
- **Theme: Material 3, `ColorScheme.fromSeed` monochrome variant, bold black & white.**
  `dynamic_color` is OFF (not a dependency). v1 spends **zero hue** — color is reserved for
  bridges (v2) behind an unused `BridgeAccent` theme extension. Ship light + dark + a Pure-Black
  OLED toggle. Surfaces come from M3 `surfaceContainer` roles (tonal), not hardcoded colors.
- **Typeface: Schibsted Grotesk**, self-hosted (`assets/fonts/`, bundled — NEVER runtime-fetch).
  Everything flows through M3 `TextTheme` roles. A mono (JetBrains Mono) carries tabular figures
  (coords, distances, timestamps, QR fallback codes).
- **Presence encoded by FORM not color:** solid = live, hollow ring = away, dashed = stale,
  slashed = ghosted. The ghost / "you're sharing" safety signal = inverse fill + a clear label,
  **NO pulse/ripple**, never red. ≥48dp tap targets + `Semantics` labels on interactive controls.
- **Radii** from the typed `AppRadii` theme extension (8/12/16/24/28/full); bottom sheets get the
  28 top-radius. Elevation is tonal — no drop-shadow spray.

## Craft rules (grep-enforced)
- Widget **classes**, never `Widget _buildX()` helper methods.
- `const` on every eligible widget. No hardcoded `Color(0x…)`/`Colors.x`/raw `fontSize:` in leaf
  widgets — pull from `Theme.of(context)` / `TextTheme` / the theme extensions.
- `MediaQuery.sizeOf` / `LayoutBuilder`, never `MediaQuery.of(context).size` or platform branching.
- `withValues(alpha:)`, never `withOpacity`. `AnimatedOpacity`, never bare `Opacity`.
- `ListView.builder` for lists, never a `Column` of many rows. Dispose controllers/subscriptions.

## Layout
Feature-first: `lib/features/<feature>/{data,domain,presentation}`; shared design system in
`lib/theme/`, shared widgets in `lib/widgets/`, service/provider wiring in `lib/services/` +
`lib/providers.dart`. The server API base + WS live in `lib/services/api/`.

## Validate
`flutter analyze` (zero warnings) → `flutter test` (incl. alchemist goldens for the stable
primitives: presence dot, ghost toggle, QR frame) → drive it (`flutter run -d chrome`) and
screenshot against the mockup.
