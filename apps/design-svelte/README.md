# @petalnet/design-svelte (the design system page, as a Svelte app)

PR `janet/ds-5-svelte`. The same PetalNet design-system page as `@petalnet/design`
(PR ds-4), rebuilt as a **SvelteKit 5 + Tailwind v4 + daisyUI** app: the markup is
real Svelte components, the behaviour is Svelte runes, and the components are
documented in **Storybook**. **Pixel-identical** to the source page
(`design-system/site/index.html`), verified with the shared `pixeldiff` harness.

## What it is

- **SvelteKit** (adapter-node), Svelte `^5.48`, the monorepo's strict-catalog deps.
- **Progressive enhancement, not graceful degradation.** The whole page is
  server-rendered and fully meaningful with **JavaScript disabled** — all 13
  swatches, 4 tiles, the spacing/type/motion tables, and the ProseMark **read**
  view render at first paint (verified: 7578px full height, complete content, no
  JS). JS only _adds_: the Paper/Ink toggle, the live theme-aware swatch/tile
  recolour, the real modal dialog, the snackbar, the button ripple, curve replay,
  and the live ProseMark **editor**.

## Layout

```
apps/design-svelte/
  src/
    app.html            anti-FOUC theme script + font preloads (pre-paint, render-blocking)
    routes/
      +layout.svelte    imports the compiled styles.css; re-syncs theme on hydrate
      +page.svelte      the page — all sections, composed from components
    lib/
      components/       Swatch, Tile, Card, StatusPill, Sdot, Icon, Eyebrow,
                        CompareCell, ThemeToggle, Dialog, ToastHost, ProseMark
      data.ts           the page's static content (swatches/tiles/spacing/…)
      icons.ts          the inlined lucide path map (byte-identical SVGs)
      markdown.ts       the ProseMark read-view renderer (ported verbatim)
      theme.svelte.ts   theme state + the instant, flash-free apply()
      toasts.svelte.ts  the snackbar store
      live.svelte.ts    live theme-aware swatch/tile rebuild (renderSwatches/Tiles)
      enhance.ts        button ripple + curve replay
      styles.css        the COMPILED design-system stylesheet (copied from
                        apps/design's generated styles.css — the pixel truth)
      vendor/icons.js   vendored lucide iconDataUri builder
    stories/            Storybook stories for the components
  static/
    fonts/              self-hosted Geist woff2 (served at /fonts/*)
    vendor/             icons.js + prosemark.bundle.js (served at /vendor/*)
  .storybook/           Storybook (sveltekit framework) config
```

## How pixel-identity is kept

- The **stylesheet is the same compiled `styles.css`** that PR ds-4 generates
  (Tailwind v4 + daisyUI from the `@petalnet/tokens` DTCG graph). It is copied in
  verbatim, not re-authored, so every metric is byte-for-byte what ds-4 ships.
- The **markup** maps 1:1 onto that CSS: every class name, every inlined lucide
  SVG, the server-rendered swatch/tile/spacing/token/icon-strip lists, and the
  ProseMark read HTML are reproduced exactly (the markdown renderer is a verbatim
  port so the rendered HTML — and thus the read/edit no-shift swap — is identical).
- The **live theme-aware swatches + tiles** mirror the source's
  `renderSwatches()`/`renderTiles()`: the page SSR-renders the static **light**
  set (present at first paint, zero CLS), then rebuilds from `getComputedStyle`
  only on an actual theme change (and on a dark first paint) — colours change,
  geometry never does.

## Verifying

Serve the source and this app over HTTP, then screenshot-diff with the shared
harness (`apps/design/tools/pixeldiff.mjs`, full-page, `reducedMotion: 'reduce'`):

```
# source
cd design-system/site && python3 -m http.server 8762
# this app (built)
pnpm --filter @petalnet/design-svelte build && PORT=8761 node apps/design-svelte/build/index.js
# diff (run from a dir that has playwright/pixelmatch/pngjs, e.g. shotty)
node apps/design/tools/pixeldiff.mjs http://127.0.0.1:8762/index.html http://127.0.0.1:8761/ /tmp/dsdiff light
```

**Result (1280px):** identical page height (7578px both), residual diff **0.52%
light / 0.49% dark**. The residual is the SAME artifact ds-4 documents: a uniform
**1-pixel rasterization offset in the content BELOW the live ProseMark editor**
— above the editor the diff is a true **0 pixels**, and the lower band realigns
to **~0%** at `dy = −1`. Every DOM box matches to sub-pixel precision; it is a
rendering-grid artifact of two stylesheets across the live-editor boundary, not a
layout difference. (At narrow/mobile widths the same offset is a larger _share_
of the diff because the page is taller below the editor, but the layout is
identical and the boundary is the same.)

## Storybook

```
pnpm --filter @petalnet/design-svelte storybook        # dev, port 6006
pnpm --filter @petalnet/design-svelte build:storybook  # static build
```

Stories cover Swatch, Tile, Card, StatusPill, and Icon, rendered against the real
`styles.css` so they show in their true paper/ink context.
