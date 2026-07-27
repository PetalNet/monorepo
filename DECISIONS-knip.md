# DECISIONS — bump knip (SvelteKit config detection)

Branch: `chore/bump-knip` off `origin/main` (dc4260a). Unrelated to #341/#332/#340.

## Task

Bump knip to latest; Eli expected it to fix the "SK3 config" detection issues, and to let us
drop SvelteKit-related workarounds from `knip.config.ts`.

## What "SK3 config" means here

The repo pins `@sveltejs/kit: 3.0.0-next.8` (pnpm-workspace.yaml catalog). SvelteKit 3 lets the
Kit config live inside `vite.config.ts` — passed as options to the `sveltekit()` Vite plugin —
instead of a `svelte.config.js`. Neither `apps/console` nor `apps/grove` has a `svelte.config.js`.

knip 6.17.1's SvelteKit plugin only looked at `config = ['svelte.config.js']`, so the repo worked
around it by pointing the plugin at the Vite config by hand:

```ts
"apps/console": { sveltekit: { config: ["vite.config.ts"] } },
"apps/grove":   { sveltekit: { config: ["vite.config.ts"] } },
```

## Which knip version actually landed the fix

`knip@6.19.0` — "feat: support new optional sveltekit config pattern via vite config" (PR
[#1810](https://github.com/webpro-nl/knip/pull/1810), closes #1809). The PR body says it was
written and tested against `sveltekit@3.0.0-next.4`, i.e. exactly our SK3 case.

It changes the plugin to `config = ['svelte.config.js', ...viteConfig]` and adds precedence logic:
a `svelte.config.js` is skipped when the Vite config calls `sveltekit(...)`.

Bumped to **6.29.0** (latest, published 2026-07-22), which contains it.

## The catch: console vs grove

`resolveFromAST` in 6.29.0 (`dist/plugins/sveltekit/resolveFromAST.js`) guards the Vite-config path:

```js
if (options.configFileName.startsWith("vite.config")) {
	if (!hasImportSpecifier(program, "@sveltejs/kit/vite", "sveltekit")) return [];
	return toInputs(getLibFromViteConfig(program));
}
```

- **`apps/grove`** calls `sveltekit()` imported straight from `@sveltejs/kit/vite`. The new
  auto-detection matches, so its whole `sveltekit: { config: [...] }` override was **removed**. ✅
- **`apps/console`** configures Kit through `svelte-plugin-composer`'s `kit()` wrapper
  (`import { compose, kit } from "svelte-plugin-composer"`). The import specifier check never
  matches, so the plugin contributes **nothing** for console.

So on 6.29.0 with the config untouched, console lost every SvelteKit-derived input. Running
`knip` at that point reported:

- 125 unused files (the entire `src/routes` + `src/lib/components` tree)
- 8 unused dependencies (`@lucide/svelte`, `daisyui`, `tailwindcss`, the OTel trio, …)
- 16 unresolved `$lib/...` imports (the `$lib` alias comes from the plugin)
- 37 unused exports + 31 unused exported types

This is a genuine gap: knip does static AST analysis of `vite.config.ts` and cannot see through a
third-party wrapper that calls `sveltekit()` internally. Passing `sveltekit: { config: [...] }`
does not help — `resolveFromAST` bails on the import check regardless of how the file was found.

### Decision

Restate for `apps/console` only the two things the plugin would otherwise contribute — the
production entry patterns and the `$lib` alias — with a comment explaining why. Rejected
alternatives:

- **Rewrite console's `vite.config.ts` to call `sveltekit()` directly.** Changes real build
  behaviour (composer merges SER / global-typescript / Kit config) to satisfy a linter. Out of scope.
- **Add a decoy `svelte.config.js` to console.** It would make knip take the `svelte.config.js`
  branch, but SvelteKit ignores that file when options are passed to `sveltekit()`. A file that
  lies about the build is worse than an explicit knip config.

## Changes

| File                                             | Change                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `pnpm-workspace.yaml`                            | `dev` catalog: `knip: ^6.16.1` → `^6.29.0`                                                             |
| `pnpm-lock.yaml`                                 | regenerated via `pnpm install --no-frozen-lockfile` (6.17.1 → 6.29.0)                                  |
| `knip.config.ts`                                 | removed root `"."` `entry: ["vite.config.ts"]`; removed `apps/grove` entirely; reworked `apps/console` |
| `apps/console/src/lib/data/cost.ts`              | dropped 4 dead type re-exports                                                                         |
| `apps/console/src/lib/server/api/console-api.ts` | dropped 1 dead type re-export                                                                          |

Workarounds **removed** (the point of the task):

- `workspaces["apps/grove"].sveltekit.config` — auto-detection now works. The `apps/grove` key is
  gone entirely, it held nothing else.
- `workspaces["."].entry: ["vite.config.ts"]` — knip 6.21.0 ("Detect Vite config dependencies")
  finds it on its own; 6.29.0 flagged it as a redundant-entry config hint, which is fatal under
  `treatConfigHintsAsErrors: true`.
- `workspaces["apps/console"].paths["$app/env"|"$app/server"]` — two hand-mapped `$app` subpaths
  replaced by the single `ignoreUnresolved: ["\\$app/.+"]` that mirrors the plugin.

Workaround **added** (console only, unavoidable — see above): SvelteKit production entries,
`$lib` / `$lib/*` paths, `$app/.+` unresolved-ignore.

## New real findings, fixed

The bump surfaced 5 genuinely dead type re-exports that 6.17.1 missed. Verified by grep that every
consumer imports these from the original module, not through the re-exporting barrel:

- `apps/console/src/lib/data/cost.ts` — `CostComparisonMetricKey`, `CostComparisonReceipt`,
  `CostComparisonRequest`, `CostComparisonSide` re-exported from `@petalnet/types`. Consumers
  (`cost/service.ts`, `cost/compare.ts`) import them from `@petalnet/types` directly.
  `CostComparisonMetricKey` and `CostComparisonSide` are still imported _locally_ in `cost.ts` and
  used there — only the re-export was dropped.
- `apps/console/src/lib/server/api/console-api.ts` — `TerminalTarget`. The file imports it from
  `../domain/terminal/service.ts` for its own use; nothing consumed the re-export.
  `TerminalAdapter` in the same statement _is_ consumed, so it stays.

Nothing was blanket-ignored, and no findings were left unfixed.

## Verification

Baseline on `origin/main` @ knip 6.17.1: `lint:knip` and `lint:knip:prod` both exit 0.

After the bump (knip 6.29.0):

- `vp run lint:knip` — exit 0, clean
- `vp run lint:knip:prod` (`knip --strict`) — exit 0, clean
- `vp run check` (typecheck + lint + fmt:check) — exit 0
- `vp run manypkg` — exit 0
- `vp run typesync:check` — exit 0
- `vp run test` — exit 0 (38 files, 264 tests passed)
- `pnpm install --frozen-lockfile` (what CI does) — exit 0, so the lockfile is consistent

### Positive controls

A clean knip run is also what you get from an empty graph, so both apps were checked with a canary
rather than trusted on the exit code:

- **console** — added `src/lib/knip-canary.ts` plus an unused export in `src/lib/config.ts`. knip
  reported `Unused files (1)` and `Unused exports (1)`. Both reverted. Confirms the route/`$lib`
  graph is genuinely traversed.
- **grove** — added `src/lib/grove-canary.ts`; knip reported it as unused. Reverted. Separately,
  grove's `src/routes/+page.svelte` and `+layout.svelte` are imported by nothing yet are _not_
  reported unused — they can only be reachable as plugin-provided production entries, which is
  direct evidence the auto-detection replaced the removed override rather than silently dropping it.

### Lockfile churn

`pnpm-lock.yaml` moves ~450 lines, but the diff is confined to knip and its own transitive tree:
`oxc-parser` 0.135.0→0.140.0, `oxc-resolver` 11.21.3→11.24.2, `smol-toml` 1.6.1→1.7.0, `unbash`
4.0.1→4.0.3, plus a new `picomatch@4.0.5`/`fdir@6.5.0`. The `picomatch` bump is shared, so a few
`eslint-plugin-svelte` peer-resolution ids re-hash; no other direct or catalog dependency changed.

## Upstream follow-up (not blocking)

Worth filing against webpro-nl/knip: the SvelteKit plugin's `hasImportSpecifier(program,
'@sveltejs/kit/vite', 'sveltekit')` check makes the SK3 Vite-config path unusable for anyone
wrapping `sveltekit()` in a helper (here, `svelte-plugin-composer`). An escape hatch — honouring an
explicit `sveltekit: { config: [...] }` override without the import check, or letting the user name
the wrapper call — would let console drop its restated entries too.
