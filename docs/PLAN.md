# PetalNet/Monorepo — plan

## Repo

- Name: `PetalNet/monorepo` (lowercase m).
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

```tree
PetalNet/monorepo/
├── apps/           # each ships independently
├── packages/       # shared libs: ui, utils, types
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

## Auxiliary tooling

- `knip` — dead code
- `manypkg check` — workspace consistency
- `update-ts-references` — TS project refs
- `typesync` — `@types/*` drift
- **Renovate** — required, not deferred. Pinned versions across catalogs/workspaces rot without it.

Excluded (publishing-tooling, not earning weight here): `node-modules-inspector`, `changesets`.

## Open

- Per-app dockerfiles vs. shared base image — resolves when the layout + CI shape settles.
