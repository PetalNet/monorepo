# Building Flutter UI with AI — a Playbook

*For Janet: you're strong at HTML/CSS craft and the headless-screenshot loop. This maps that muscle onto Flutter, where the terrain differs (no DOM to diff, a static analyzer as your best friend, and a real render-target requirement). Opinionated throughout — options collapsed to picks.*

---

## 1. TL;DR

- **The single most important tool: the official Dart & Flutter MCP server** (`dart mcp-server`, Dart 3.9+). It's the connective tissue that lets an agent hot-reload, introspect the widget tree, read runtime errors, and screenshot a *running* app. It is what turns "emit Dart blind" into "render → see → fix." Everything else is secondary.
- **The single most important habit: work in small increments behind guardrails, never on faith.** Flutter's own "Morgan's Law" — the model *will* eventually do the wrong thing. Small task → analyzer + tests + a driven run → human gate. Big-bang generation is where Flutter slop comes from.
- **Your web loop has a direct analog.** Web: render HTML headless → screenshot → read PNG → fix. Flutter: `flutter run -d chrome/linux` in debug → MCP `take_screenshot` + `get_widget_tree` → read PNG → edit → `hot_reload` → re-screenshot. Sub-second reloads make it tight.
- **The analyzer is your TypeScript+ESLint gate, and it's unusually powerful in Flutter.** `dart analyze` + `flutter_lints` mechanically catches the top slop-tells: missing `const`, deprecated APIs (`withOpacity`), `BuildContext`-across-await. Treat "zero analyzer warnings" as non-negotiable, *before* you ever look at pixels.
- **Design system is the target, never raw pixels.** Map to `ColorScheme.fromSeed` / `TextTheme` / `ThemeExtension`; reuse existing widgets before creating new ones. This is what keeps light/dark/theming free and stops the magic-number spray.
- **Pick your stack and pin it in a rules file.** One state-management choice (Riverpod), one theming approach, one component philosophy — pinned in `CLAUDE.md`/`AGENTS.md`. Paradigm-mixing (`setState` + Provider + stray GetX) is the loudest AI slop tell.
- **Design-to-code generators are draft-quality, not pipelines.** Only *token export* (Supernova) and the *MCP-agent-in-the-loop* survive into a real codebase. Screen generators = spaghetti risk. v0/Bolt/Lovable don't do Dart at all.
- **The craft bar is mechanizable.** Widget *classes* not `_buildX()` methods, `const` everywhere, no hardcoded colors, `MediaQuery.sizeOf`/`LayoutBuilder` not platform branching, dispose your controllers. Most of it is a lint or a grep.

---

## 2. The recommended toolchain

**Coding agent: Claude Code + the Dart/Flutter MCP server.** *Why:* whole-repo reasoning, `CLAUDE.md` briefings, skills, and PreToolUse hooks (wire `dart analyze` / `dart format` as gates) — and Dart's static analyzer gives it an unusually tight correctness signal. *Reach for it:* as your default and only agent. This is the box you already live in.

**The non-negotiable core: Dart & Flutter MCP server** (`dart-lang/ai`). *Why:* it's the ONE piece that lets the agent see and drive the running app — widget-tree introspection, runtime-error fetch, hot reload/restart, screenshots, `pub_dev_search`, run-tests. *Reach for it:* always, day one. `claude mcp add --transport stdio dart -- dart mcp-server`.

**Theming: `ColorScheme.fromSeed` (built-in) as the floor; `flex_color_scheme` when brand demands it.** *Why:* `fromSeed` derives a tonally-correct, WCAG-aware M3 palette from one brand color — the single biggest lever against the default-blue-Material look. *Reach for FlexColorScheme:* when you have 2–3 real brand colors and need multi-seed / precise tone→role control. *Android bonus:* add `dynamic_color` for Material You wallpaper palettes with a `fromSeed` fallback.

**Component library: stay on Material 3 for Point (Android-first).** *Why:* Android-idiomatic, lowest dependency cost, theming is pure `ThemeData`. *Reach for a shadcn port (`shadcn_ui` — most mature, Material-interop) only if* you deliberately want to escape the Material look; not worth it for an Android-first map app.

**Typography: `google_fonts`, runtime-fetch while iterating → self-hosted assets before ship.** *Why:* explore type instantly, then go deterministic/offline. Lean on M3 `TextTheme` roles; 1–2 families max.

**Icons: Material `Icons` (default) — or `flutter_lucide` if you go shadcn.** *Why:* zero-dependency, matches M3. Lucide only pairs naturally with a shadcn aesthetic.

**Motion: `flutter_animate` for micro-interactions; built-in implicit animations for state tweens; `Hero` for shared-element.** *Why:* `.animate()` chained effects (`300.ms`) is the fastest path to UI that feels alive with minimal boilerplate.

**Component isolation: Widgetbook.** *Why:* Storybook-for-Flutter — a flat, addressable catalog of every component state, so the agent renders one use-case directly instead of navigating the whole app to reach an edge case. Use-cases double as golden-test fixtures.

**Visual regression gate: `alchemist` golden tests.** *Why:* renders widgets headlessly to PNG (no emulator), and solves the cross-host determinism problem — readable "platform goldens" for the agent's visual judgment, Ahem-font "CI goldens" (colored blocks) for the stable merge gate.

**Lints: `flutter_lints` minimum; consider `very_good_analysis`.** *Why:* mechanically enforces `const`, kills deprecated APIs, catches `use_build_context_synchronously`. Treat warnings as errors.

**A11y: built-in `meetsGuideline` matchers.** *Why:* `androidTapTargetGuideline` (≥48dp), `textContrastGuideline`, `labeledTapTargetGuideline` are fully automatable pass/fail gates — better than web, where you'd need an extra axe-core pass.

**Skills to install:** `npx skills add flutter/skills` + `dart-lang/skills` (responsive layouts, routing, tests, static-analysis fixes — Google's own blueprints).

---

## 3. The AI build loop for Flutter

This is the render→see→fix loop that gives you the same tight visual feedback you get headless-screenshotting HTML. There are two tracks — a **runtime loop** (the real headless-browser analog) and a **golden loop** (the deterministic gate). Run both.

### Recipe A — full-app runtime loop (closest to your web loop)

1. **Run the app in debug on a headless-friendly target.** `flutter run -d chrome` or `-d linux` (desktop/web avoids needing an emulator on a shared host). Debug build = VM Service open, which is what MCP attaches to.
2. **Attach the Dart MCP server** to the running VM Service.
3. **Drive and see:** `get_widget_tree` → navigate/tap to the target screen → `take_screenshot` → **`Read` the PNG** (your eyes) → edit source → `hot_reload` (sub-second, preserves state) → `take_screenshot` again. Repeat until parity. Use `hot_restart` when you touched `main`/global state.
4. **When you hit a `RenderFlex overflowed`:** read the widget tree to understand the layout, fix (`Expanded`/`Flexible`/`ellipsis`/scroll), hot reload, re-screenshot. This exact loop is what the MCP docs are built around.
5. **Gate:** `dart analyze` (zero warnings) + `meetsGuideline` a11y tests before moving on.

### Recipe B — single-component loop (fastest for one widget)

1. Author a **Widgetbook use-case** for the widget's states.
2. Render it in isolation and screenshot — OR generate a **throwaway `alchemist` golden with `autoUpdateGoldenFiles = true`**, run it to emit a PNG, `Read` the PNG, compare to your reference, iterate, then delete the throwaway. (This is VGV's flagship Figma-to-Flutter trick — vision reads its own rendered output.)
3. Edit → regenerate/hot-reload → re-read.

### Recipe C — deterministic CI regression gate

- Keep permanent `alchemist` **CI goldens** (Ahem font, colored blocks) for stable primitives → byte-diff in CI. Stable across hosts; catches "something moved." Don't try to *judge* appearance from these — they're change-detectors, not quality judges.

### The honest gaps vs. your web loop (know these)

- **No text-diffable DOM.** Your cheapest "read" is the semantics/widget tree (text the agent parses); your true-visual read is a PNG you must actually look at. Use both — the tree for structure, the PNG for craft.
- **Golden tests are pixel-diffs, not "does this look right."** You still have to look.
- **Runtime loops need a debug build + a render target.** On the shared host, target web/desktop — don't spin an Android emulator unless you specifically need device behavior.
- **The native `@Preview` previewer has no screenshot API yet.** If you use it, point your existing shotty/shot.js at its Chrome preview server URL and Read that — same as any web page.

**Your existing headless-Chrome tooling is directly reusable** for both `flutter -d chrome` and the `@Preview`/Widgetbook web servers. You already have the eyes; MCP gives you the hands.

---

## 4. Impeccable-for-Flutter: a craft checklist

Pass/fail rubric mirroring the web "impeccable" bar. Most items are a lint or a grep.

**Theming**
- [ ] `ColorScheme.fromSeed(seedColor:, brightness:)` drives the palette. **Zero** `Colors.blue`, `Color(0x…)`, raw `fontSize:`, or magic `EdgeInsets` numbers in leaf widgets — grep for them; their presence = fail.
- [ ] Custom tokens (brand surfaces, spacing scale) live in a typed `ThemeExtension`, not scattered constants.
- [ ] **Light AND dark both render correctly** — this is the proof colors are token-driven. Use new M3 surface-container roles, not deprecated `background`/`surfaceVariant`.

**Typography**
- [ ] Type flows through M3 `TextTheme` roles (`displayLarge`…`labelSmall`), not inline `TextStyle(fontSize:)`. 1–2 font families.

**Spacing (8pt grid)**
- [ ] Spacing snaps to an 8dp scale via named constants/`ThemeExtension`, not arbitrary `EdgeInsets.all(13)`.

**Widget decomposition**
- [ ] **No `build()` over ~40–50 lines.** Decomposed into named `StatelessWidget`/`StatefulWidget` **classes**, NOT `Widget _buildHeader()` helper methods. (Methods can't be `const`, re-execute on every parent rebuild, and can't halt the rebuild traversal — this is the #1 differentiator.)
- [ ] Widgets split by *change frequency*: volatile state isolated in its own leaf so `setState` doesn't rebuild static siblings.

**Responsiveness / adaptive**
- [ ] Layout branches on `MediaQuery.sizeOf(context)` / `LayoutBuilder` constraints + Material breakpoints (Compact <600, Medium 600–839, Expanded ≥840dp) — **never** on `defaultTargetPlatform` or top-level `OrientationBuilder`.
- [ ] No orientation lock; content width constrained on large screens; `SafeArea` used; respects `MediaQuery.textScaleOf` (no fixed heights that overflow when text scales).
- [ ] **Zero `RenderFlex overflowed` at any tested size.** For a nav shell across form factors, use `flutter_adaptive_scaffold`.

**Motion**
- [ ] Meaningful transitions (`animations` package shared-axis/container-transform for routes; `Hero` for shared elements; `flutter_animate` for entrance/emphasis). No `Opacity` widget for fades — use `AnimatedOpacity` (avoids expensive `saveLayer`).

**A11y**
- [ ] Interactive elements have `Semantics`/labels; tap targets ≥48dp; contrast passes (`meetsGuideline` tests green).

**Const-correctness**
- [ ] `prefer_const_constructors` satisfied — `const` on every eligible widget (canonicalizes instances, short-circuits rebuilds). Analyzer-enforced.

**Top slop-tells to grep out**
- `Widget _buildX()` helper methods → extract to classes.
- `color.withOpacity(0.5)` → `withValues(alpha: 0.5)` (deprecated since 3.27).
- `ListView(children: [...])` / `Column` of many items → `.builder`.
- Mixed state-management paradigms in one repo.
- Missing `const` everywhere.
- Hardcoded colors/sizes in leaf widgets.
- `RaisedButton`/`FlatButton` (→ `ElevatedButton`/`TextButton`), `MediaQuery.of(context).size` (→ `sizeOf`).

---

## 5. State management + architecture for AI-legible UI

**Pick: Riverpod 2.x. Pin it in the rules file.**

*Why Riverpod over Bloc/Provider/`setState`:*
- **Compile-time safe** — the class of "provider not found / wrong type" runtime errors that LLMs love to introduce become *analyzer errors caught before run*. This is the decisive property: it moves the model's characteristic mistakes into the gate you already run.
- **`BuildContext`-independent**, testable in isolation, fine-grained rebuilds. More concise and better async ergonomics than Bloc's event→state boilerplate (which LLMs will happily generate mountains of, and occasionally mis-wire).
- **Keep `setState` for genuinely leaf-local ephemeral state** (a toggle, a text field). The slop pattern is hoisting shared state into a giant `StatefulWidget`; keep it scoped to a leaf.

*Bloc is the runner-up* — its rigid, un-improvisable template is highly AI-legible and worth it when you *want* enforced structure across a team. For Point (small, solo-ish, Android-first), Riverpod's conciseness + compile-time safety wins.

**Architecture: feature-first.** `lib/features/<feature>/{data,domain,presentation}`. Deep modules over shallow leaky ones so the agent works through testable seams. The point is legibility: the agent should never have to guess where a thing lives.

---

## 6. Pitfalls (and the guard for each)

- **Deprecated APIs from stale training data** (`withOpacity`, `RaisedButton`, `MediaQuery.of().size`). → **Pin the Flutter version in the rules file**; `flutter_lints` + `dart analyze` flags them; treat warnings as errors.
- **Giant `build()` / `_buildX()` helper methods.** → Rules-file rule + review grep: decompose into widget classes.
- **Missing `const`.** → `prefer_const_constructors` lint; let the analyzer drive insertion.
- **`RenderFlex overflowed`** (unconstrained flex children). → Caught the instant you run the visual loop; fix with `Expanded`/`Flexible`/`ellipsis`/scroll. This is *why* you run the app, not just compile it.
- **`setState() called during build` / after `dispose`.** → `mounted` guard; `addPostFrameCallback`; `use_build_context_synchronously` lint for `BuildContext` across `await`.
- **Un-disposed controllers/subscriptions.** → Rubric item + review; dispose in `dispose()`.
- **Hallucinated package APIs / "manufacturing solutions that don't exist."** → `pub_dev_search` via MCP to ground on real packages; small increments + a driven run catches fabrication fast.
- **Mixed/hallucinated state-management paradigms.** → Pin ONE choice (Riverpod) in the rules file.
- **Bad responsiveness by default** (platform branching, width-gobbling, ignoring text scale). → Rubric + test at multiple sizes via `device_preview` (first-pass) and `alchemist` device configs (deterministic).
- **Big-bang generation.** → The meta-guard: small bounded tasks with acceptance criteria, self-validate on `flutter test` + `flutter analyze`, human-gate every widget. "Smaller tasks = higher success rate."
- **(If you add an AI *feature* to the app):** never put API keys in the client — they're extractable from the compiled binary. Route through your own backend.

---

## 7. Apply it to Point

Point = Android-first Material 3 location-sharing client: map UI, live presence dots, share/contacts surface, ghost on/off toggle, device-linking QR. Concrete calls:

**Stack for Point**
- **Agent:** Claude Code + Dart MCP server (day one). Run `flutter run -d chrome` in debug for the fast visual loop during build; validate real map/GPS behavior on an Android emulator/device only for the map-specific passes.
- **Theming:** `ColorScheme.fromSeed` from Point's brand color + `dynamic_color` (Android-first — Material You wallpaper palettes feel native, with a `fromSeed` fallback). Both light and dark from the start.
- **State:** Riverpod. Presence stream, ghost toggle, and session/link state are exactly the async, compile-time-checked surface Riverpod is best at.
- **Components:** Material 3. Don't reach for a shadcn port — Android-idiomatic is the goal.
- **Nav shell:** `flutter_adaptive_scaffold` so the contacts/share surface reflows if you ever hit tablet/foldable.

**Screen-by-screen**
- **Map + live presence dots:** the map is a plugin surface (google_maps_flutter / MapLibre) — treat markers as your widgets, keep marker-building in named classes, and drive presence off a Riverpod stream so only the marker layer rebuilds. This screen is where you'll fight `RenderFlex`/overlay issues — lean hard on the runtime screenshot loop.
- **Presence dots as a component:** build them in **Widgetbook use-cases** (online/away/ghosted/stale states) and screenshot each in isolation — far faster than navigating the live map to reach each state. Animate appearance/pulse with `flutter_animate`.
- **Ghost on/off toggle:** leaf-local `setState` for the switch's visual + a Riverpod action for the actual state change. This is a safety-critical control — give it a clear `Semantics` label, ≥48dp target, and an unmistakable on/off visual (don't rely on color alone). Golden-test both states.
- **Share/contacts surface:** `ListView.builder` (never a `Column` of contacts). Constrain content width on large screens. Widgetbook use-cases for empty/loading/populated.
- **Device-linking QR:** constrain the QR to a fixed sensible box, `SafeArea`, high-contrast, and a text fallback code beneath it. Test at large text-scale — QR screens are a classic overflow spot.

**Loop discipline for Point**
- Ship a **`CLAUDE.md`** pinning: Flutter version, Riverpod, Material 3 + `fromSeed`/`dynamic_color`, feature-first layout, "zero analyzer warnings," and the exact validate commands (`flutter analyze`, `flutter test`).
- Spec-first per feature (interview → spec → bounded tasks), one screen at a time, each closed via Recipe A, gated by analyzer + `meetsGuideline` + a driven run before you look at the next.
- Golden-test the *stable primitives* (presence dot, ghost toggle, QR frame) with `alchemist`; don't golden the whole live map.

**Skip for Point:** design-to-code screen generators (draft spaghetti), GenUI/A2UI (alpha; Point's UI isn't agent-generated at runtime), Firebase Studio (sunsetting), FlutterFlow (walled-garden structure fights a hand-rolled rebuild). If you ever want a design front door, use **Google Stitch** for a screen sketch → export Dart as a *starting draft only*, or **Supernova** for token export — nothing hands-off.

---

## 8. Sources

**Core loop / MCP / agents**
- Dart & Flutter MCP server: https://docs.flutter.dev/ai/mcp-server · https://dart.dev/tools/mcp-server · https://github.com/dart-lang/ai/tree/main/pkgs/dart_mcp_server
- `Arenukvern/mcp_flutter` (closed-loop harness): https://github.com/Arenukvern/mcp_flutter
- marionette_mcp: https://github.com/leancodepl/marionette_mcp
- Flutter Agent Skills: https://docs.flutter.dev/ai/agent-skills · https://github.com/flutter/skills · https://github.com/dart-lang/skills
- Claude Code for Flutter: https://www.freecodecamp.org/news/how-to-use-claude-code-to-build-flutter-apps-faster-best-practices/
- Antigravity / Gemini CLI (context): https://docs.flutter.dev/ai/antigravity · https://blog.flutter.dev/meet-the-flutter-extension-for-gemini-cli-f8be3643eaad

**Verification loop**
- VGV Figma→Flutter golden-loop skill (flagship): https://verygood.ventures/blog/figma-to-flutter-claude-code-skill-golden-tests/
- alchemist: https://github.com/Betterment/alchemist · https://verygood.ventures/blog/alchemist-golden-tests-tutorial/
- matchesGoldenFile: https://api.flutter.dev/flutter/flutter_test/matchesGoldenFile.html
- Widgetbook: https://www.widgetbook.io
- Widget Previewer: https://docs.flutter.dev/tools/widget-previewer
- device_preview: https://pub.dev/packages/device_preview
- A11y testing / meetsGuideline: https://docs.flutter.dev/ui/accessibility/accessibility-testing · https://api.flutter.dev/flutter/flutter_test/meetsGuideline.html

**Theming / design system**
- ColorScheme.fromSeed: https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.fromSeed.html
- M3 new color roles / migration: https://docs.flutter.dev/release/breaking-changes/new-color-scheme-roles · https://docs.flutter.dev/release/breaking-changes/material-3-migration
- dynamic_color: https://pub.dev/packages/dynamic_color
- FlexColorScheme: https://pub.dev/packages/flex_color_scheme · https://docs.flexcolorscheme.com/
- flutter_adaptive_scaffold: https://pub.dev/documentation/flutter_adaptive_scaffold/latest/
- google_fonts: https://pub.dev/packages/google_fonts
- flutter_animate: https://pub.dev/packages/flutter_animate · animations package: https://medium.com/flutter-community/the-new-animations-package-explained-gskinner-blog-6507585a75ff
- Supernova (token export): https://github.com/Supernova-Studio/exporter-flutter
- Component libs: https://forui.dev · https://pub.dev/packages/shadcn_ui

**Craft, pitfalls, rules**
- Flutter AI best practices (Morgan's Law, guardrails): https://docs.flutter.dev/ai/best-practices
- Flutter AI rules template: https://github.com/flutter/website/blob/main/src/content/ai/best-practices/index.md
- Performance best practices (const, rebuilds, lists): https://docs.flutter.dev/perf/best-practices
- Method-vs-class widgets: https://medium.com/@vortj/flutter-daily-why-splitting-widgets-into-methods-is-actually-a-bad-habit-dad3edc3eead
- Adaptive/responsive best practices: https://docs.flutter.dev/ui/adaptive-responsive/best-practices
- Common errors / RenderFlex: https://docs.flutter.dev/testing/common-errors
- withOpacity deprecation / wide-gamut: https://docs.flutter.dev/release/breaking-changes/wide-gamut-framework
- Effective Dart / lints: https://dart.dev/effective-dart · https://pub.dev/packages/flutter_lints · https://github.com/VeryGoodOpenSource/very_good_analysis
- Themes / ThemeExtension: https://docs.flutter.dev/cookbook/design/themes
- State management comparison: https://flutterfever.com/flutter-bloc-vs-riverpod-vs-provider-2025/
- Serverpod vibe-coding (increments, hallucinations): https://serverpod.dev/blog/vibe-coding-flutter

**Workflow scaffolding**
- Andrea Bizzotto ACT: https://agentictoolkit.dev/
- VGV 7 MCP servers: https://verygood.ventures/blog/7-mcp-servers-every-dart-and-flutter-developer-should-know
- Prescriptive AGENTS.md example: https://github.com/Prime-Holding/flutter-packages/blob/main/AGENTS.md