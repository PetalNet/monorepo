# Point Flutter client — current build rules

The implemented client's design record is
[`../docs/design/UI-SPEC-FINAL.md`](../docs/design/UI-SPEC-FINAL.md). The checked-in
mockup is historical visual reference; current source and tests are authoritative
for shipped behavior.

## Non-negotiables

- **Flutter 3.44.6** is pinned in `mise.toml` (and CI). Install it from this
  directory with `mise install --yes flutter`, then run `flutter pub get`.
  The `pubspec.yaml` SDK floor is Dart 3.10. **Zero `flutter analyze` warnings**
  is a gate.
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

## Platforms and validation

Android is the production target: location, foreground-service, notification,
deep-link, and native Rust behavior must be checked on an Android device or
emulator. Web may be useful for layout iteration but cannot validate those
platform paths. This repository does not contain iOS or desktop runner projects.

```sh
mise install --yes flutter
flutter pub get
flutter analyze
cargo build --manifest-path rust/Cargo.toml --locked --release
LD_LIBRARY_PATH="$PWD/rust/target/release" flutter test
flutter build apk --release
tool/check_version_code.sh
tool/check_apk_libs.sh
```
