# PetalNet/Monorepo

The plan + canonical decisions: [tasks task-178](https://tasks.petalcat.dev/task/178).
Full spec snapshot: [docs/PLAN.md](./docs/PLAN.md).

## Layout

```tree
apps/         each ships independently
packages/     shared libs (tokens, ui, utils, types)
tools/        repo-internal scripts
docs/         design / architecture / runbooks
```

## Stack

- **pnpm 11** with workspace `catalog:` for shared dep versions
- **Vite+** for build / test / lint / fmt / task running (`vp run` with `dependsOn`, `-r`, `-t`, content-addressable cache)
- **oxlint + eslint** dual lint, overlap killed by `eslint-plugin-oxlint`
- **DTCG tokens** in `packages/tokens/`, compiled by `style-dictionary` to CSS vars + Tailwind preset + typed TS
- **Tailwind v4 + DaisyUI** as the runtime styling layer
- **knip + manypkg + typesync + update-ts-references** for hygiene
- **Renovate** for dep bumps
- No Turbo, no Prettier, no changesets

## Status

**Not live yet.** Migrations of source repos land here over the next sessions; originals stay authoritative until Parker greenlights the cutover.
