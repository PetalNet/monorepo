# Vendored PetalNet design tokens (paper/ink)

**This is a COPY of the token/theme CSS only.** The canonical design system is
`PetalNet/design-system` (design.petalcat.dev) — the paper/ink tokens and daisyUI
themes here mirror it; re-sync if the canonical values move, and consume it as a
package if one ever ships.

## What's here

- `tokens/tokens.css` — primitives + semantic light/dark custom properties
  (`--color-petal-*`, `--radius-*`, `--spacing-*`, motion easings), both
  `[data-theme]` blocks in one file.
- `tokens/daisyui.css` — daisyUI v5 `paper` (light, default) + `ink` (dark)
  themes as `@plugin "daisyui/theme"` blocks.
- `app.css` — the single live-build entry: Tailwind v4 + the daisyUI plugin
  (with Clarity's collision excludes) + both token files.

## What's deliberately NOT here

The DS Svelte components that were once vendored alongside (Card, Dialog,
ProseMark, toasts, …) are gone: Clarity renders its own visual identity from
`$lib/clarity/clarity.css` and used none of them (the deletion test held — no
caller lost anything). If Clarity ever adopts shared DS components, take them
from the canonical repo, not from history.

## Layering contract

`+layout.svelte` imports `app.css` (this substrate) FIRST, then
`$lib/clarity/clarity.css` (the Clarity identity: monochrome, user-configurable
accent). Both define `--bg/--text/--accent`-family variables at `:root` —
clarity.css must stay the later import so its values win.
