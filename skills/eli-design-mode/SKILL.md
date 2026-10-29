---
name: eli-design-mode
description: The lab's UI craft bar, layered on /impeccable. Use when building or reviewing any lab UI — a screen, component, or theme.
---

# Design mode

Build every screen to **/impeccable** first — that's the base UI bar. This is the craft layer on top,
Eli's rules. Where the two agree they reinforce; where this is silent, /impeccable governs.

Lab stack: Tailwind + DaisyUI + SvelteKit + Svelte 5. It's **Material 3**, not Material _Expressive_. Eli
reviews terse and itemized — he zooms in and diffs padding/radius, so nothing drifts.

## Surfaces

- **Borderless.** Separate surfaces with hairline rules + background/elevation — never a `border` or a
  faked `box-shadow: inset 0 0 0 1px`. Sole exception: one M3 _outlined_ tile.
- **Material 3 cards** (filled/elevated/outlined) with M3-correct hover — real cards, not borderless
  mystery boxes.
- **Flat UI chrome.** Depth from elevation + hairline rules alone — no glow, cursor-light, parallax,
  reveal-on-scroll, or heavy shadows.
- **Gradients are light, not decoration.** A gradient is fine only when it models real light on a
  real material (brass, paper, a lit sphere): one hue, lightness varying along one light direction,
  and every lit object on the screen shares that one light source. Banned: hue-to-hue (purple→green),
  same-hue two-tone "depth" (purple→darker purple), and adding fake depth to rescue something that
  looks corporate. Eli: "when it looks fake and corporate you don't fix that by adding fake depth,
  that's fraud." If a surface is meant to be a material, it must read as that material, matching
  the same material elsewhere on the page, not as a tinted border.
- **Small ~2px radius** by default; pill radius only where the pattern demands it (e.g. chat bubbles).

## Layout & structure

- **8pt grid, pixel-consistent** — matching elements share padding/radius/size via shared classes.
- **Decompose into many small shared components** — reach for a component before hand-rolling HTML; it's
  the main defense against drift.
- **Logical properties** (`padding-inline-start`, `margin-inline`) for RTL; `hanging-punctuation` for
  polish.
- Keep only controls that earn their place; scope changes to the ask, don't restyle for its own sake.

## Type

- Lighter weight, **default tracking — no custom kerning** (kerning is a human's call).
- **Self-host fonts via `fontless`** (Geist typeface). Setup detail in [REFERENCE.md](REFERENCE.md).

## Icons & copy

- **Lucide for every icon** — author a missing icon as an external SVG file. Icons, never emoji or inline
  SVG in the UI.
- **Minimal, em-dash-free copy.** Empty state = "All caught up."

## Color & theming

- **DaisyUI custom themes** (CSS variables) — build on DaisyUI, prefer it over raw Tailwind, skip DTCG.
- **One accent, theme-swapped, following light/dark** (no picker). The accent is project-supplied — e.g.
  the lab site uses Parker's paper-ink burnt-sienna; a given app defines its own in its brief. Whatever the
  accent, verify it against the contrast rules (see Accessibility).

## Motion

- **Animate every state change** — quick, subtle, joyful ("that's nice"); reach for `svelte-motion` only
  for a deliberate showpiece.
- **Spinner only during real poll/stream**, never at idle.

## Components

- **Focus ring = an outline that hugs the radius** — space chips so adjacent rings clear each other;
  interactive surfaces only.
- **Real dialog components**; wire every affordance to a real action. **Avoid toasts, they are an
  antipattern** (Primer: not recommended, significant a11y problems) — default to persistent banners,
  inline validation, and dialogs kept close to what triggered them, not transient auto-dismissing
  toasts. See [REFERENCE.md](REFERENCE.md).
- **Match each skeleton to its content** (a message skeleton ≠ an image skeleton).

## Accessibility

- **AAA is the target for everything except contrast**, easing to AA only where AAA is genuinely
  unreasonable.
- **Contrast: WCAG 2 AA is the hard floor** (4.5:1 text, 3:1 large text and UI). **APCA is the quality
  bar:** body text Lc 75 minimum (Lc 90 preferred), other content text Lc 60, large text and UI
  Lc 45. Measure both themes; dark mode is where WCAG 2 overstates and APCA catches it. APCA is not
  a standard yet (WCAG 3's algorithm is undecided), so never drop the AA floor for it.

## Markdown parity

Where content is both composed and rendered (a markdown editor), the two views must match to the pixel.
Full diff checklist in [REFERENCE.md](REFERENCE.md).

## Done when

A screen is done only when **every** item holds — check, don't assume:

- Every rule above applied: surfaces borderless, icons Lucide, spacing on the 8pt grid and identical
  under zoom.
- **Contrast measured** (not eyeballed) on every text/surface pair: WCAG 2 AA and the APCA Lc targets, both themes.
- Where markdown renders, read and edit **diffed in a headless browser** and pixel-identical.
- `tsc` + lint (`--max-warnings=0`) + knip + fmt all green, each fixed at the root, none suppressed.
- Verified live in-browser across **Chrome, Safari, and Firefox** — the real build, not the demo.
