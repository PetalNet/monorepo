# Generated-output samples

Committed snapshots of the daisyUI v5 themes the build emits from our DTCG
tokens (`tools/daisyui.mts`). `dist/` is gitignored, so these checked-in copies
are the in-repo proof of what `pnpm --filter @petalnet/tokens build` produces.

- `daisyui.paper.css` — light theme (`default`)
- `daisyui.ink.css` — dark theme (`prefersdark`)

Regenerate after a token change:

```bash
pnpm --filter @petalnet/tokens build
cp dist/daisyui.paper.css dist/daisyui.ink.css packages/tokens/samples/
```
