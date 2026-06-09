# @petalnet/design (the design system page)

The living PetalNet design-system page: paper and ink, one accent, quiet by
default. It wears the system it documents.

This is a **static site** (`site/index.html` + `site/styles.css` + assets). It
is intentionally *not* a pnpm workspace package yet — there is no `package.json`,
so `pnpm install` ignores it. A build step (fontless, asset hashing, wiring into
the Vite/`packages/tokens` pipeline) is a follow-up PR in the design-system
stack; this PR (`janet/ds-1-extract-css`) only brings the page into the monorepo
with its CSS extracted.

## Layout

```
apps/design/
  site/
    index.html    the page — zero inline styles, zero <style> block
    styles.css    all styling, external
    fonts/        self-hosted Geist woff2 (served at /fonts/*)
    vendor/       icons.js + prosemark.bundle.js (served at /vendor/*)
```

## CSS extraction (PR janet/ds-1)

The source design page lived at `design-system/site/index.html` with a ~760-line
`<style>` block plus 27 inline `style=""` attributes scattered through the
markup. This PR moved **all** of it into `site/styles.css`:

- The entire `<style>` block was lifted verbatim into the top of `styles.css`
  and replaced in the page with `<link rel="stylesheet" href="styles.css">`.
- Each of the 27 markup `style=""` attributes was replaced with a descriptive
  utility / data class (`.mt-14`, `.chip-bg-petal`, `.space-bar-128`,
  `.curve-360-out`, `.body-ink`, etc.) defined in the new
  "EXTRACTED INLINE STYLES" block at the bottom of `styles.css`. Values are
  byte-for-byte what the inline attributes held.

After extraction the markup carries **zero** `style=""` attributes and **no**
`<style>` block.

### Known carve-out: 5 JS-generated inline styles

Five `style="..."` strings remain inside `<script>` template literals (the
swatch chip background, a tile status dot, two ProseMark line-offset
calculations, and an editor-failure fallback). These are built into the DOM at
**runtime** with **dynamic** values (an arbitrary color read from the live
theme, a `calc()` of a runtime line-height, etc.). They are not static markup
attributes and cannot be moved to a stylesheet without rewriting the JS to emit
classes; left for a later pass. They do not affect the static rendered page.

## Verifying pixel-identity

Serve both the original and this page over HTTP (the absolute `/fonts/` and
`/vendor/` paths need a docroot) and screenshot-compare:

```
# original
cd design-system/site && python3 -m http.server 8732
# extracted
cd apps/design/site && python3 -m http.server 8731
```

A default-motion screenshot diff shows a tiny (~0.2%) difference confined to the
skeleton-loading shimmer — that animation is time-dependent and differs between
any two captures of the *original* too. Capturing both with
`reducedMotion: 'reduce'` (which freezes the shimmer, as the spec intends) yields
a **0-pixel** diff: the extracted page is pixel-identical.
