# Architecture

How this monorepo wants to be used.

## Three-tier dependency layout

```mermaid
flowchart TD
    apps["apps/*<br/>Shipped to humans — SvelteKit, FastAPI, static, native.<br/>One folder per deployable unit."]
    packages["packages/*<br/>Shared libs — @petalnet/tokens, @petalnet/ui, @petalnet/utils.<br/>Used by 2+ apps; type-only or runtime."]
    tools["tools/*<br/>Repo-internal — migration scripts, codegen, one-off ops.<br/>Not workspaced; not consumed by anyone."]
    runner["vp run -r ...<br/>The task runner."]

    apps -->|depends on| packages
    runner -.->|runs| apps
    runner -.->|runs| packages
    runner -.->|runs| tools
```

Apps depend on packages. Packages depend on other packages (sparingly). Apps never depend on each other directly — extract the shared bit to a package.

## Tokens flow

```mermaid
flowchart LR
    prim["src/primitives/*.json"] --> sd["style-dictionary"]
    sem["src/semantic/*.json"] --> sd
    sd --> css["dist/tokens.css"] --> tw["Tailwind v4 @theme + DaisyUI @plugin"]
    sd --> preset["dist/tailwind.preset.js"] --> presets["Tailwind config presets array"]
    sd --> idx["dist/index.js"] --> tsimports["TS imports (canvas, SVG, email)"]
```

DTCG is the authoring source. Tailwind + DaisyUI are the runtime. The semantic layer is what theme-switches; primitives stay the same across themes.

## Task graph (vp run)

Per `vite.config.ts`:

```mermaid
flowchart LR
    typecheck --> lint --> test --> build
    cache[("shared content-addressable cache")]
    typecheck -.-> cache
    lint -.-> cache
    test -.-> cache
    build -.-> cache
```

`vp run -r build` walks the workspace package dependency graph, hits each app/package's `build` script, caches output by content + env. Rebuilds skip the cache on miss; everything else replays.

## Lint pipeline

```mermaid
flowchart LR
    oxlint["oxlint (fast path)"] --> eslint["eslint (the rest, with overlap disabled by eslint-plugin-oxlint)"]
```

oxlint runs first because it's ~10-100x faster on the same rules. The overlap-disable preset is regenerated from `.oxlintrc.json` so what oxlint enables, eslint stops reporting.

## CI

`.github/workflows/ci.yml`: pnpm install → `vp run --cache` typecheck/lint/test/build, plus `manypkg check`, `typesync --dry=fail`, and `knip`. Fail-fast; no auto-merge of major bumps.

## Adding an app

1. Open an issue using the **New app** template (sanity check on naming + owner).
2. Scaffold under `apps/<slug>/` with workspace name `@petalnet/<slug>`.
3. Wire its scripts (`build`, `dev`, `test`, `lint`, `typecheck`) so `vp run` picks them up.
4. Add `@petalnet/tokens` if it has any styled surface.

## Migrating an existing repo

See `docs/MIGRATION.md` for the method + audit trail.
