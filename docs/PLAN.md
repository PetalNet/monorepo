# PetalNet/Monorepo — plan

## Repo

- Name: `PetalNet/Monorepo` (capital M).
- Migration per source repo:
  1. In a local clone, `git mv` contents into the target subdir (e.g. `apps/clarity/`) and commit.
  2. Add as a remote on Monorepo, `git merge --allow-unrelated-histories source/main`.
  3. Git rename-detection keeps `git log --follow` walking back through the original paths.

  No filter-repo, no history rewrite, SHAs unchanged. Original repos archive in place after Monorepo is proven.

## Scope

**In** (apps, packages, shared utilities — anything Janet ships normally):
clarity, launchpad, tasks (UI + server), ideas, corner, matrix-bot, derek
_library bits_, mocklab variants, slide, PetalBoard, CollegeMap, tracker,
homelab-docs (public-facing content), shared FE packages, shared utils.

**Out** (private / sensitive / deployment-coupled):

- `petalnet-infra` (secrets, compose files)
- Anything in `/home/docker/.claude/shared/*` holding tokens/passwords
- Compose files, traefik dynamic configs
- The bedtime/lights/derek wrapper scripts in `/home/docker/.claude/bin/` (path-coupled to docker@10.10.10.14)
- `tasks/data/*.db` content
- Derek's _applier_ cron-wrapper (the algorithm can live as a library inside; the cron-wrapper stays out)

## Layout

```
PetalNet/Monorepo/
├── apps/           # each ships independently
├── packages/       # shared libs: tokens, ui, utils, types
├── tools/          # repo-internal scripts
├── docs/           # design / architecture / runbooks (homelab-docs lands here)
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

## Stack

- **Package manager:** pnpm 11, `catalog:` for shared dep versions.
- **Toolchain:** Vite+ — covers build (`vp build`), test (`vp test` / Vitest), lint (`vp lint`), format (`vp fmt` / oxfmt), task running (`vp run` with `dependsOn`, `-r`, `-t`, filters, content-addressable cache, parallel mode).
- **No Turbo. No Prettier.** `vp run` is the task runner; `oxfmt` is the formatter.
- **Node:** `^20.19 || ^22.12 || >=24`.

## Linting

Dual: `oxlint` (fast) + `eslint` (the rest). Disable overlap via the oxc-published `eslint-plugin-oxlint` preset (`pluginOxlint.buildFromOxlintConfigFile()`) so nothing double-reports.

ESLint config based on `lishaduck/deputy`'s flat-config pattern. Consume `@eslint-deputy/*` packages (`internal-config`, `tailwind`, `svelte`, `imports`, `node`, `pnpm`, `sonar`, `tsconfig`, `vitest`). They aren't on npm yet — vendor via pnpm catalog with git deps or workspace symlink until they are. PRs to deputy when our usage exposes gaps.

## Tokens (`packages/tokens/`)

- **Source:** DTCG JSON in `src/`. Two layers: `primitives/` (raw values: `color.amber.500 = #f59e0b`) and `semantic/` (`color.bg = {color.gray.950}` for dark, `{color.gray.50}` for light).
- **Compiler:** `style-dictionary`.
- **Outputs (3):**
  1. `dist/tokens.css` — CSS custom properties consumed by Tailwind v4's `@theme` and DaisyUI's `@plugin "daisyui/theme"`.
  2. `dist/tailwind.preset.ts` — Tailwind preset object; apps import & merge.
  3. `dist/index.ts` — typed exports for non-Tailwind callsites (canvas, SVG strings, email templates).

Primary runtime is Tailwind + DaisyUI. DTCG is the authoring format only.

## Auxiliary tooling

- `knip` — dead code
- `manypkg check` — workspace consistency
- `update-ts-references` — TS project refs
- `typesync` — `@types/*` drift
- **Renovate** — required, not deferred. Pinned versions across catalogs/workspaces rot without it.

Excluded (publishing-tooling, not earning weight here): `node-modules-inspector`, `changesets`.

## Open

- Per-app dockerfiles vs. shared base image — resolves when the layout + CI shape settles.
