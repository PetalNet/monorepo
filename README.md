# PetalNet/Monorepo

PetalNet applications and shared libraries live in this monorepo. JavaScript and
TypeScript projects share a pnpm workspace and Turborepo task graph. Rust services
share a root Cargo workspace. Python projects share a uv workspace and lockfile.
Point's Flutter client and its Rust bridge remain
standalone.

## Layout

```tree
apps/         independently shipped applications and services
packages/     shared TypeScript libraries and configuration
skills/       the lab's own agent skills, linked into .agents/skills
docs/         repository architecture, migration history, and design specs for
              systems that span several apps
```

### Applications

- Web and Node: `chaos`, `clarity`, `clarity-mcp`, `collegemap`, `grove`, `petalboard`, `slide`, and `tasks`
- Rust: `box-agent`, `control-plane`, `courier`, `dispatcher`, `manager`, and the
  Point server
- Flutter: the Point client under `apps/point/app`

### Shared packages

- `@petalnet/better-auth-effect-qb-adapter`
- `@petalnet/effect-api` and `@petalnet/effect-sveltekit`
- `@petalnet/vault-cite` (primary-source capture and evidence search)
- `@petalnet/vault-engine` (Loro-backed claim store, Obsidian projection, recall and research runs)
- `@petalnet/tsconfig`, `@petalnet/types`, `@petalnet/ui`, and `@petalnet/utils`

## Toolchain

- Mise installs pnpm; pnpm provisions the Node runtime pinned in `package.json`. Use `pnpm exec node` for standalone Node commands.
- Mise or the Nix dev shell supplies uv. The workspace uses Python 3.13.
- Turborepo for cached tasks, standalone Vite for builds, Vitest for tests, and Oxfmt for formatting
- oxlint and ESLint for linting; Knip, manypkg, typesync, and
  update-ts-references for workspace hygiene
- Tailwind CSS v4 for pnpm apps that use Tailwind, except `apps/petalboard` and
  `apps/slide`, which remain on the shared Tailwind v3 legacy catalog
- Cargo with root `rust-toolchain.toml`, `Cargo.toml`, and `Cargo.lock` for Rust
  services; Flutter tooling and a separate Cargo lock for Point's client bridge

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

Run a Python app from its directory with `uv run --locked <command>`, or
select it from the root with `uv run --locked --package <name> <command>`.
Run one suite with `UV_ISOLATED=1 pnpm exec turbo run test --filter=<name>`.
Run all Python suites with `UV_ISOLATED=1 pnpm exec turbo run test --filter='petalnet-python^...'`.
The desk and phone suites use PortAudio and Opus, respectively.
The root sync installs only the root project. Select Envgen for its geospatial
libraries and add `--extra lidar` for LAZ files. Dictation-model training uses
`--extra train`, and its tests use `--extra cpu --extra test`.
Chatterbox's production model runs in its own GPU environment.

Rust remains Cargo-native; the pnpm/Turbo workflows do not run Rust tasks yet.
Install Rust lazily with `mise install --locked rust` from the repository root:

```sh
cargo build --workspace --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all --check
```

Point's tests require PostgreSQL and a `DATABASE_URL`; its CI job supplies both.
Manager's tmux integration tests remain a separate opt-in run.
Use `-p <crate>` to work on one service, such as `cargo run -p courier`.
Outputs live in root `target/`. Point's bridge retains its separate
`apps/point/app/rust/target/` and lockfile.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for repository mechanics and
[`docs/MIGRATION.md`](./docs/MIGRATION.md) for the historical migration journal.
