# PetalNet/Monorepo

PetalNet applications and shared libraries live in this monorepo. JavaScript and
TypeScript projects share a pnpm workspace and Vite+ toolchain; Rust and Flutter
projects keep their language-native workspaces and toolchains.

## Layout

```tree
apps/         independently shipped applications and services
packages/     shared TypeScript libraries and configuration
docs/         repository architecture and migration history
```

### Applications

- Web and Node: `clarity-mcp`, `collegemap`, `console`, `grove`, and `slide`
- Rust: `box-agent`, `control-plane`, `courier`, `dispatcher`, `manager`, and the
  Point server
- Flutter: the Point client under `apps/point/app`

### Shared packages

- `@petalnet/better-auth-effect-qb-adapter`
- `@petalnet/console-bus-rpc`
- `@petalnet/svelte-ws`
- `@petalnet/tsconfig`, `@petalnet/types`, `@petalnet/ui`, and `@petalnet/utils`

## Toolchain

- Node 26 (see `.nvmrc` and `package.json`) and pnpm 11
- Vite+ (`vp`) for task running and formatting
- oxlint and ESLint for linting; Knip, manypkg, typesync, and
  update-ts-references for workspace hygiene
- Tailwind CSS v4 for pnpm apps that use Tailwind, except `apps/slide`, which
  remains on the shared Tailwind v3 legacy catalog
- Cargo and Flutter tooling for non-pnpm projects

Install dependencies with `pnpm install`. Run the root workflows through Vite+:

```sh
vp run check
vp run test
vp run build
```

Useful focused commands include `vp run lint:knip`, `vp run manypkg`, and
`vp run typesync:check`. Root script definitions are in [`package.json`](./package.json),
and workspace membership and dependency catalogs are in
[`pnpm-workspace.yaml`](./pnpm-workspace.yaml).

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for repository mechanics and
[`docs/MIGRATION.md`](./docs/MIGRATION.md) for the historical migration journal.
