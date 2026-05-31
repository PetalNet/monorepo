# @petalnet/tokens

DTCG design tokens for PetalNet. Compiled by [style-dictionary](https://styledictionary.com/) to three outputs.

## Sources

```
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

```
dist/
├── tokens.css           CSS custom properties (light + dark), scoped by [data-theme]
├── tailwind.preset.js   Tailwind preset — `import preset from '@petalnet/tokens/tailwind'`
├── index.js             typed exports for non-Tailwind callsites (canvas, SVG, email)
└── *.d.ts               tiny hand-written declarations
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
