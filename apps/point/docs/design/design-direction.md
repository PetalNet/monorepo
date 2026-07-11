# Point — Design Direction (v1)

*Flutter / Android-first / Material 3 · E2EE location sharing · "Matrix for location"*

## Synthesis

Point is **bold, monochrome, and tactile**: a high-contrast black-and-white Material 3 app where the entire chromatic channel is held in reserve as a future semantic ("this entity is bridged from another network"). The core native experience — people, presence, the map — is rendered in confident greyscale with strong weight contrast and generous curves. It should feel like **Beeper's restraint and layered dark surfaces** wearing **a monochrome skin**, on **nexus's clean feature-first Riverpod bones**, but curvier and slicker than any web UI — big rounded sheets, spring motion, tactile toggles.

---

## Palette & theme — the B&W system

**Method (token-driven, not magic numbers).** Build the `ColorScheme` from a neutral seed with the monochrome scheme variant so M3 hands you a *true greyscale* tonal palette for free, then hand-tune the `surfaceContainer` ladder and add a `PureBlack` override:

```dart
ColorScheme.fromSeed(
  seedColor: const Color(0xFF000000),
  brightness: Brightness.dark, // and .light
  dynamicSchemeVariant: DynamicSchemeVariant.monochrome,
)
```

This is the elegant answer to "bold B&W" while staying WCAG-aware and light/dark-free — and it satisfies the playbook's "map to `fromSeed`, zero raw `Color(0x…)` in leaf widgets" bar. Surfaces come from **M3 `surfaceContainer` roles** (tonal elevation), never hardcoded per-widget.

**Surface tone ladder** (anchored to Beeper's real dark values: `#000` / `#101010` / `#1c1c1c`, borderless, text `#F6F6F6`):

| Role | Dark (default) | Dark (Pure Black / OLED toggle) | Light |
|---|---|---|---|
| `surface` | `#0E0E0E` | `#000000` | `#FFFFFF` |
| `surfaceContainerLowest` | `#0A0A0A` | `#000000` | `#FFFFFF` |
| `surfaceContainer` | `#1A1A1A` | `#0D0D0D` | `#F0F0F0` |
| `surfaceContainerHighest` | `#262626` | `#1A1A1A` | `#E2E2E2` |
| `onSurface` (ink) | `#F6F6F6` | `#F6F6F6` | `#0A0A0A` |
| `onSurfaceVariant` (muted) | `#A0A0A0` | `#A0A0A0` | `#5A5A5A` |
| `outlineVariant` (hairline) | `#FFFFFF @ 10%` | `#FFFFFF @ 8%` | `#000000 @ 10%` |

Depth is **tonal, not shadowed** — Beeper runs `border-width: 0` and layers surfaces by tone. Match that: hairlines only where genuinely needed. Offer a **Pure Black** appearance toggle (OLED battery, exactly Beeper's option) that collapses the low end of the ladder to `#000`.

**Minimal-accent policy.** v1 ships **zero chromatic accent by default.** State is encoded with **tone + form + motion**, never hue:
- Presence dots: **solid** filled dot = live now · **ring/hollow** = away · **dashed/faded** = stale · **slashed / ghost glyph** = ghosted. Distinguishable in pure greyscale and to color-blind users.
- The one safety-critical signal — *"you are broadcasting" (ghost OFF)* — reads via an **inverted fill + a slow pulse ring + a filled-vs-outline icon + a text label**, not a red. This keeps the chromatic channel semantically pure.

**Color = bridges, reserved.** Define a `BridgeAccent` slot in the theme extension that is **null/unused in v1**. When bridges land (v2), each external network gets one saturated hue applied *only* to bridged entities (avatar ring, network chip, marker halo) — so color's *first appearance in the product* unambiguously means "not native Point." Do not spend any hue in v1; that's the whole point.

---

## Shape & feel — curvy & slick

Lean **into** M3's rounded shapes; never sharpen them back. Radii live in a typed `ThemeExtension` (`AppRadii`), not scattered `circular(5)` calls:

| Token | Value | Use |
|---|---|---|
| `xs` | 8 | chips, tags, inline |
| `sm` | 12 | buttons, inputs |
| `md` | 16 | cards, list tiles, images (nexus already uses `circular(16)` on images) |
| `lg` | 24 | dialogs, menus |
| `xl` | 28 | **bottom sheets** (big top corners), FAB, hero sheets |
| `full` | 999 | avatars, presence dots, the ghost pill toggle |

Bottom sheets and the share surface get the **28 top-radius** treatment (Beeper's dialog uses a larger bottom radius for exactly this feel). Elevation = M3 tonal only. No drop-shadow spray.

---

## Typography

nexus rides raw M3 `TextTheme` defaults (Roboto) — good discipline, but too plain for a "bold B&W" identity. Direction:
- **Flow everything through M3 `TextTheme` roles** (`displayLarge…labelSmall`) — zero inline `TextStyle(fontSize:)` (nexus's `post.dart` `_PostBody` has a `fontSize: 24` with a "need better styling" TODO — that's the anti-pattern to avoid).
- **One brand family: a crisp grotesk (Inter or Geist)** for the whole app, `google_fonts` while iterating → **self-hosted assets before ship** (playbook). Boldness is carried by **weight contrast** (heavy display/headline weights against regular body) — the identity lever for monochrome.
- **Tabular figures** for coordinates, distances, timestamps, and the QR fallback code.

---

## Components & navigation

**Adhere from nexus:**
- **Adaptive nav shell** (`packages/app/lib/src/app/wrapper.dart`): `NavigationBar` on compact, `NavigationRail` on medium+ — driven by the `MaterialWindowSizeClass` extension in `packages/app/lib/src/utils/responsive.dart`. Clean, correct, adopt the pattern.
- **Widget-class decomposition** (`post.dart` splits into `_PosterInfo` / `_PostBody` / `_PostInteractables` classes, not `_buildX()` methods) — the exact craft the playbook demands.
- **Theme wiring**: `themeMode` read from a Riverpod settings service into `MaterialApp` (`app.dart`); modern `surfaceContainerHighest` role already used (no deprecated `background`/`surfaceVariant`).

**Beeper-like surfaces:** borderless, tone-layered list rows; high row density with comfortable tap targets; restrained chrome; dual-pane on foldables/tablets (reuse the rail branch); the Pure Black option.

**Point screens:**
- **Map + presence dots** — `flutter_map`/MapLibre (nexus proves `flutter_map` in `map_page.dart`) with a **monochrome tile style** (CARTO positron/dark-matter-style) so the basemap is on-brand B&W. Markers are your widgets in named classes; presence drives a Riverpod stream so only the marker layer rebuilds. Build the dot states as **Widgetbook use-cases** (live/away/stale/ghost) and golden-test them.
- **Ghost on/off toggle** — a large `full`-radius pill switch, safety-critical: ≥48dp, explicit `Semantics` label, unmistakable **inverse-fill + pulse** on/off states (never color-only), leaf-local `setState` for the visual + Riverpod action for the real state change. Golden both states.
- **Contacts / share** — `ListView.builder` rows (avatar + name + presence dot + last-seen), share via a `xl`-radius bottom sheet. Content width constrained on large screens. Empty/loading/populated use-cases.
- **Device-linking QR** — high-contrast **black QR on white card** (works in both themes), framed in a `lg` rounded container, `SafeArea`, with a **tabular text fallback code** beneath. Test at max text-scale (classic overflow spot).

**Loom flavor + past-Point continuity** (build agent studies both on its host): carry Loom's dense, calm **chat/contact-row rhythm** and identity/presence chips into the contacts and share surfaces; preserve the existing Point **map + presence metaphor** and any established iconography so this reads as the same product, refined — not a reboot.

---

## Motion

- Routes: `animations` package **shared-axis** (peer nav) / **container-transform** (contact → profile, marker → detail sheet).
- `Hero` for avatar → profile.
- `flutter_animate` for micro: presence-dot appearance stagger, the ghost-toggle pulse, sheet spring-in.
- Implicit `AnimatedFoo` for state tweens; **`AnimatedOpacity`, never bare `Opacity`** (avoids `saveLayer`).
- Sheets use a spring-ish curve for the "tactile" feel. Keep it subtle — motion signals state, doesn't decorate.

---

## From nexus: ADHERE / STEAL / DROP

**ADHERE** (copy the pattern):
- `wrapper.dart` adaptive `NavigationBar`/`NavigationRail` shell + `responsive.dart` `MaterialWindowSizeClass` breakpoints (<600/<840/…).
- Feature-first layout `features/<f>/{data,domain,presentation}`; **Riverpod** (`hooks_riverpod`) + `flutter_hooks`.
- Widget-class decomposition (`post.dart`).
- `packages/_analysis_options` on **`very_good_analysis`** with `prefer_relative_imports` — stricter than the playbook's `flutter_lints` floor; keep it.
- `design.dart`'s *structure* (light+dark `ColorScheme` + `themeMode` from settings) — keep the shape, swap the seed to monochrome.

**STEAL** (adapt):
- `map_page.dart`'s `flutter_map` + tile-layer approach → re-skin to a **monochrome** basemap style. Big on-brand win.
- The `ClipRRect(borderRadius: circular(16))` image-rounding idiom → promote to the `md` token.

**DROP** (outdated / overengineered / off-brand):
- **`design.dart` is too thin** — no `ThemeExtension`. Point needs typed tokens (`AppRadii`, presence tones, spacing, the reserved `BridgeAccent`). Build it; don't inherit the bare one-seed theme.
- **Inline `TextStyle(fontSize: 24)`** in `post.dart` `_PostBody` (with its own "need better styling" TODO) → M3 role.
- **Hardcoded `BorderRadius.circular(5)` + inline `ButtonStyle` + `Container(alignment:)` nesting** in `settings_page.dart` → radii from tokens (and 5px is far too sharp for this direction); use `ListView` + settings tiles.
- **`MediaQuery.of(context).size.height`** in `log_in_page.dart:242` and `sign_up_page.dart:254` → `MediaQuery.sizeOf` / `LayoutBuilder` (playbook slop-tell).
- **Backend/env stack** (`appwrite`, `dio`, `envied`) — irrelevant to Point's E2EE/Matrix-shaped backend; don't inherit.
- **Desktop deps** (`window_manager`, `os_detect`) — Point is Android-first mobile; drop.
- **The multi-package pub-workspace split** (separate `_analysis_options` package, `RestorationMixin`/`restorationScopeId` ceremony in `app.dart`) — overengineered for an AI-first solo build; a single-package app with one shared `analysis_options.yaml` is more legible.

---

## Open tensions — for Parker + Eli to sign off

1. **`dynamic_color` / Material You.** Playbook explicitly recommends it (Android-native feel). It **directly conflicts** with the brand: Material You injects the user's *wallpaper hues* into surfaces, breaking both "bold B&W" and "color = bridges." → **Recommend: disable dynamic color for core surfaces; ship fixed monochrome.** (Biggest deviation from the playbook — needs an explicit yes.)
2. **Router.** nexus uses **`auto_route`** (codegen, typed routes); the more common/AI-legible choice is **`go_router`** (official, less codegen magic). → **Recommend `go_router`** for legibility + official support. Eli's app uses auto_route, so this is a call for him.
3. **Nav shell impl.** nexus hand-rolls the adaptive shell; playbook recommends **`flutter_adaptive_scaffold`**. → **Recommend `flutter_adaptive_scaffold`** for the shell, keeping nexus's breakpoint values. Low-stakes.
4. **Safety-critical broadcast signal without color.** Encoding "you're sharing" via **form + inverse + motion** (keeps color reserved) vs. spending **one safety hue** for unmistakability/accessibility. → **Recommend form+motion in v1**, revisit if usability testing shows it's not instantly obvious.
5. **Default dark = near-black vs Pure Black `#000`.** → **Recommend near-black M3 default + a Pure Black OLED toggle** (mirrors Beeper exactly). Decision, not conflict.
6. **Typography.** Android-idiomatic **Roboto** (nexus, zero-cost, dynamic) vs a **brand grotesk** (Inter/Geist) for a slicker bold identity. → **Recommend a single brand grotesk**; this is a taste call for Parker.
7. **Lint strictness.** `very_good_analysis` (nexus) can fight AI codegen with rules like `public_member_api_docs`. → **Recommend keeping VGA but relaxing doc-comment lints on the app package.** Minor.

---

Sources: [Beeper Android beta blog](https://blog.beeper.com/p/new-beeper-android-app-open-beta), [Beeper M3 Expressive / Pure Black (9to5Google)](https://9to5google.com/2025/10/07/beeper-for-android-gets-material-3-express-updates-google-voice-integration/), [Beeper desktop/iOS revamp (9to5Google)](https://9to5google.com/2025/02/25/beeper-desktop-ios-new-apps-beta/), [darker-beeper-theme (concrete surface values)](https://github.com/aryxenv/darker-beeper-theme); nexus repo `PHS-TSA/nexus` (files cited inline).