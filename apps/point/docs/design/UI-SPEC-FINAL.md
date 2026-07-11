# Point client — FINAL UI spec (design LOCKED 2026-07-11)

For M1 and ALL client UI. Supersedes earlier design notes. **Build the real Flutter client to
MATCH the mockup**, using the Dart/Flutter MCP render→screenshot→fix loop so it lands
pixel-close, not roughly (see `flutter-playbook.md`).

**VISUAL TARGET = the mockup.** Gallery `point-client-mockups` (staged HTML source:
`/home/docker/point-mockups.final.html`). It shows the real screens: map + presence, ghost
toggle, People + share sheet, device-link QR, and the token system. That look is the bar.

## LOCKED decisions (do not relitigate; all signed off by Parker + Eli)
- **Typeface: Schibsted Grotesk**, self-hosted (bundle the woff/ttf in the app, NEVER
  runtime-fetch from the web). Flow through M3 `TextTheme` roles; boldness via weight
  contrast; a mono for tabular figures (coords/timestamps/codes).
- **Router: kaisel** (+ its shell). Version PINNED via `pubspec.lock`; do NOT `pub upgrade`
  it on a whim (pre-1.0, ships breaking changes). Auth-gated routing MUST NOT reset the
  router/shell on auth change (use kaisel's stack-as-state + `router.set`, guards that don't
  auto-rerun); **login page OUTSIDE the shell**; **animated adaptive shell**
  (KaiselBranchedShell + route-pair `pageWrapper`) — the shell must ANIMATE between branches,
  never a hard indexed-stack cut. This animated-shell + auth-without-reset is the acceptance bar.
- **Theme: Material 3, `ColorScheme.fromSeed` monochrome variant, bold BLACK & WHITE.**
  **dynamic_color OFF** — fixed monochrome, do NOT pull Material You wallpaper hues.
  **Color RESERVED for bridges (v2):** a `BridgeAccent` theme-extension slot, UNUSED in v1;
  v1 spends ZERO hue. Ship both light + dark, plus a Pure-Black OLED toggle. Tonal surface
  ladder (Beeper-style), borderless, hairlines only where needed.
- **Presence encoded by FORM not color:** solid = live, hollow ring = away, dashed = stale,
  slashed = ghosted. The ghost / "you're sharing" safety signal = **inverse fill + a clear
  label** — NO pulse/ripple animation (removed per Parker feedback), NO red. ≥48dp, Semantics label.
- **Maps: provider-agnostic, supporting Google Maps + MapLibre** (user-switchable; MapLibre =
  the privacy option). Monochrome basemap per provider (Google styled map / CARTO
  positron-dark for MapLibre). Markers as widget CLASSES; presence driven off a Riverpod
  stream so only the marker layer rebuilds.
- **Shape: curvy & slick** — radii 8/12/16/24/28/full in a typed `ThemeExtension` (AppRadii);
  bottom sheets get the 28 top-radius; elevation is tonal, NO drop-shadow spray.
- **State: Riverpod;** feature-first layout (`lib/features/<f>/{data,domain,presentation}`);
  widget CLASSES not `_buildX()` helper methods; **very_good_analysis** lint; **zero
  `dart analyze` warnings** as a gate before you look at pixels.
- **Motion: subtle + meaningful only** (animations package shared-axis / container-transform,
  Hero for avatar→profile, flutter_animate for micro). NO decorative pulse waves.
- **nexus (github PHS-TSA/nexus) = ENGINEERING reference ONLY** (file structure, tooling,
  Riverpod patterns, adaptive-nav, VGA lint). Its VISUAL design is NOT the target — the
  mockup is. Do not copy nexus's look.

**Method:** `flutter-playbook.md` (the render loop, craft rubric, slop-tells to grep out).
**Full rationale + the nexus ADHERE/STEAL/DROP + surface tone ladder:** `point-design-direction.md`
(staged at `/home/docker/point-fable/`). Build to match the mockup.
