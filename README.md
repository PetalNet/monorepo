# PetalNet/Monorepo

PetalNet applications and shared libraries live in this monorepo. JavaScript and
TypeScript projects share a pnpm workspace and Turborepo task graph; Rust and Flutter
projects keep their language-native workspaces and toolchains.

## Layout

```tree
apps/         independently shipped applications and services
packages/     shared TypeScript libraries and configuration
docs/         repository architecture and migration history
```

### Applications

- Web and Node: `clarity-mcp`, `collegemap`, `grove`, and `slide`
- Rust: `box-agent`, `control-plane`, `courier`, `dispatcher`, `manager`, and the
  Point server
- Flutter: the Point client under `apps/point/app`

### Shared packages

- `@petalnet/better-auth-effect-qb-adapter`
- `@petalnet/effect-api` and `@petalnet/effect-sveltekit`
- `@petalnet/tsconfig`, `@petalnet/types`, `@petalnet/ui`, and `@petalnet/utils`

## Toolchain

- Mise installs pnpm; pnpm provisions the Node runtime pinned in `package.json`. Use `pnpm exec node` for standalone Node commands.
- Turborepo for cached tasks, standalone Vite for builds, Vitest for tests, and Oxfmt for formatting
- oxlint and ESLint for linting; Knip, manypkg, typesync, and
  update-ts-references for workspace hygiene
- Tailwind CSS v4 for pnpm apps that use Tailwind, except `apps/slide`, which
  remains on the shared Tailwind v3 legacy catalog
- Cargo and Flutter tooling for non-pnpm projects

Install dependencies with `pnpm install --frozen-lockfile`. Run the root workflows:

```sh
pnpm check
pnpm test
pnpm build
```

Useful focused commands include `pnpm lint:knip`, `pnpm manypkg`, and
`pnpm typesync:check`. Cacheable repository tasks are defined in
[`turbo.json`](./turbo.json), workflow scripts remain in
[`package.json`](./package.json), and workspace membership and dependency catalogs
are in [`pnpm-workspace.yaml`](./pnpm-workspace.yaml).

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for repository mechanics and
[`docs/MIGRATION.md`](./docs/MIGRATION.md) for the historical migration journal.
