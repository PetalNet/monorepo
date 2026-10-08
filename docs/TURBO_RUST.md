# Native Cargo support in Turborepo

Turbo 2.11.7 discovers the root `petalnet-rust` Cargo workspace and its eleven
service crates without `package.json` wrappers. The standalone Point Flutter
bridge is excluded and retains `apps/point/app/rust/target` outputs.

## Configuration and commands

Each crate's `turbo.json` extends `//`, clears JS build outputs and check
dependencies, and uses `$TURBO_DEFAULT$` inputs. Cargo selects the package from
the task's working directory; no `-p` is necessary. The synthetic workspace
loads the root configuration, so only its check/lint overrides are root-qualified.
Native Clippy commands retain `--locked --all-targets` and deny warnings;
Courier also retains pedantic checking. Workspace lint adoption is a separate
stack member. Native tests are uncached; Point needs PostgreSQL, and Manager's
opt-in tmux tests require `N12_TMUX_IT=1` and `--ignored`.

```sh
mise install --locked rust
pnpm exec turbo run build --filter=agent-manager
pnpm exec turbo run lint test --filter=agent-manager
pnpm exec turbo run format --filter=agent-manager -- --check
N12_TMUX_IT=1 pnpm exec turbo run test --filter=agent-manager -- --ignored
```

Unfiltered native verification runs once through `petalnet-rust`; crate filters
run per-crate verification. Unfiltered builds select native entrypoints.
Cargo builds dependency closures; Turbo infers final binary/library deliverables,
not the incremental target tree. Library builds and formatting default uncached.

Root `pnpm build`, `test`, `check`, and `lint` use direct Turbo commands with
`--filter=@petalnet/*`. Check/lint also select `//` to retain repository tasks.
These commands do not use `--affected`, so JS execution preserves lazy Rust
installation. Affected graph discovery requires Rust even with a JS filter and
belongs in the CI selector, which can emit explicit package filters for execution.
Turbo combines positive filters as a union: selected-package execution must call
Turbo directly with those filters, not append them to the namespace-wide root
scripts. CI workflows, selection and service/security contracts are outside this
foundation.

## Affected graph interface

```sh
pnpm exec turbo query affected --packages --base BASE --head HEAD
```

Results use `data.affectedPackages.items[]` with `name`, `path`, and
`reason.__typename`. Check GraphQL `errors` as well as the process exit status:
query errors can return exit zero. Native querying requires Rust.

Verified single-file comparisons select Dispatcher plus Box Agent and Control
Plane; Point core plus Point server; and Courier core plus all four other
Courier crates. Each also selects synthetic `petalnet-rust` with
`DependencyChanged`; that aggregate must not imply every native lane changed.
Package graph fields `directDependencies` and `allDependents` expose ownership
and propagation. The excluded Flutter bridge's Point-core relationship,
PostgreSQL, tmux, shared toolchain and security inputs remain explicit contracts.

## Evidence and boundaries

Native cache validation covers filtered/unfiltered plans, Manager artifact
restoration by SHA-256, and isolated invalidation on path-library source, declared
build-script inputs, profile, target and simulated compiler identity changes.
JS validation covers namespace-filtered plans and explicit package execution with
Cargo/rustc absent, including all eleven root checks. These experiments do not
establish hosted native cache behavior or cross-compilation.
Nix execution and real Android testing remain unverified. Native support is
experimental.

Primary sources for the pinned implementation:

- [Rust guide at 2.11.7](https://github.com/vercel/turborepo/blob/v2.11.7/apps/docs/content/docs/guides/tools/rust.mdx)
- [Cargo graph, commands, hashes and outputs](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-repository/src/cargo.rs)
- [Native integration tests](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo/tests/cargo_workspace_test.rs)
- [Affected discovery before filtering](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-run/src/builder.rs#L672-L706)
- [Package configuration loader](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-turbo-json/src/loader.rs#L516-L554)
