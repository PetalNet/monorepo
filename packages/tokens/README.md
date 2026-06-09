# @petalnet/tokens

DTCG design tokens for PetalNet. Compiled by [style-dictionary](https://styledictionary.com/) to three outputs.

## Sources

```tree
src/
├── primitives/    raw values — color.amber.500 = #f59e0b, etc.
│   ├── color.json
│   ├── space.json
│   └── type.json
└── semantic/      references primitives — color.bg = {color.gray.950} in dark
    ├── light.json
    └── dark.json
```

DaisyUI's `@plugin "daisyui/theme"` and Tailwind v4's `@theme` directive consume the **semantic layer's CSS variables**, scoped under `[data-theme="..."]`. Theme-switching at runtime is one attribute flip.

## Outputs

```tree
dist/
├── tokens.css           CSS custom properties (light + dark), scoped by [data-theme]
├── tailwind.preset.js   Tailwind preset — `import preset from '@petalnet/tokens/tailwind'`
├── daisyui.css          daisyUI v5 themes (paper + ink) as `@plugin "daisyui/theme"` blocks
├── daisyui.paper.js     the `paper` (light) theme as a JS object — `import paper from '@petalnet/tokens/daisyui/paper'`
├── daisyui.ink.js       the `ink` (dark) theme as a JS object
├── index.js             typed exports for non-Tailwind callsites (canvas, SVG, email)
└── *.d.ts               tiny hand-written declarations
```

## daisyUI v5 theme

`tools/daisyui.mts` maps our resolved semantic tokens onto the daisyUI v5 theme
variables (`--color-primary`, `--color-base-100`, `--radius-box`, …). Two themes
are emitted — **`paper`** (light, `default`) and **`ink`** (dark, `prefersdark`).
The mapping is a single-accent system: `--color-primary` / `--color-accent` /
`--color-info` all resolve to `--petal`.

```css
@import "tailwindcss";
@plugin "daisyui";
@import "@petalnet/tokens/daisyui"; /* registers the paper + ink themes */
```

```ts
// Or as data (theme switchers, tooling, Storybook)
import paper from "@petalnet/tokens/daisyui/paper";
paper["color-primary"]; // "#bc5638"
```

## Use

```ts
// Tailwind config (v3-style)
import preset from "@petalnet/tokens/tailwind";
export default { presets: [preset], content: [...] };
```

```css
/* Tailwind v4 / DaisyUI */
@import "@petalnet/tokens/css";
@import "tailwindcss";
@plugin "daisyui" {
	themes:
		light --default,
		dark --prefersdark;
}
```

```ts
// Anywhere else
import { tokens, type TokenName } from "@petalnet/tokens";
const bg = tokens["semantic-color-bg"];
```

## Build

```bash
pnpm --filter @petalnet/tokens build
```
