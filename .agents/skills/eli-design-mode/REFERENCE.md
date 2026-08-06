# Design mode — disclosed reference

Setup-time and surface-specific detail pulled out of `SKILL.md` so the top stays legible. Read the section you need.

## fontless setup

Configure fonts through the `fontless` Vite plugin (self-hosted, no Google Fonts network call). fontless already emits the `@font-face` defaults — `font-display: swap`, `unicode-range`, `font-weight`, `font-style`, `font-stretch`, `font-feature-settings`, `font-variation-settings` — so set fonts via its font objects rather than hand-writing `@font-face` or re-declaring `font-display`.

What you own on top of the defaults:

- **Preload** critical fonts.
- **Fallback metrics:** `size-adjust` + `ascent-override` on fallback fonts to kill layout shift.
- **Preconnect** external services (e.g. the favicons service).

Geist is the lab typeface.

## Markdown read/edit parity

Applies only where content is both authored and rendered — a markdown editor with an edit view and a rendered read view.

Where it applies, the two views must match exactly:

- Same padding and line-height.
- Same font sizes; **code font-size equals surrounding text** unless deliberately scaled.
- Same bullet size and color.
- Same blockquote bar position and size.
- Code-block padding accounts for the fence so the block doesn't shift between modes.

**Diff the two views in a headless browser before calling it done** — don't eyeball it.
