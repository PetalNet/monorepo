# Native Cargo support in Turborepo

Primary-source review, 2026-10-07. Scope: native Cargo integration, not
`package.json` wrappers. The Cargo migration builds on
[PR #425's tooling head](https://github.com/PetalNet/monorepo/commit/e5eb33101cbb22f50ac0e9e6a2c2bf5332041bf6).

**Recommendation: verify the unified Cargo workspace before enabling Turbo's
experimental Rust tasks.** Root Cargo configuration now supplies the required
workspace identity and shared lockfile for eleven service crates. The Flutter
bridge stays standalone. See [the current workspace contract](./ARCHITECTURE.md#rust-workspace).
Turbo 2.11.7 supports native discovery, but task selection, CI parity and cache
behavior remain separate adoption gates.

## Why Cargo preparation was necessary

The table records the pre-unification boundaries, with links pinned to the
inspected tooling branch. They explain why enabling the flag alone was not a
safe migration. Workspace ownership, toolchains, CI scopes and deployment inputs
are now unified; the Flutter boundary and runtime-dependent test environments
remain intentional.

Combined resolution also exposed a native SQLite links conflict between fleet
rusqlite 0.40 and Matrix SDK 0.14's rusqlite 0.37. The root dependency aligns
fleet with 0.37; SQLx 0.9's binding range accepts libsqlite3-sys 0.35. This avoids
upgrading the Matrix SDK or SQLx APIs. Sources:
[Matrix SQLite manifest](https://github.com/matrix-org/matrix-rust-sdk/blob/matrix-sdk-0.14.0/crates/matrix-sdk-sqlite/Cargo.toml),
[rusqlite 0.37](https://github.com/rusqlite/rusqlite/blob/v0.37.0/Cargo.toml),
[SQLx SQLite 0.9](https://github.com/transact-rs/sqlx/blob/v0.9.0/sqlx-sqlite/Cargo.toml),
and [Cargo links uniqueness](https://doc.rust-lang.org/cargo/reference/resolver.html#links).

| Boundary         | Observed state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Adoption consequence                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root discovery   | The [repository root](https://github.com/PetalNet/monorepo/tree/6c8f04a27caf89dcb3620df39c71bb4c014c1109) has no `Cargo.toml` or `Cargo.lock`; [turbo.json](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/turbo.json) does not enable Cargo discovery. [pnpm-workspace.yaml](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/pnpm-workspace.yaml) pins Turbo 2.11.7.                                                      | Enabling the flag alone does not supply the documented prerequisites.                                                                                                                                         |
| Cargo ownership  | [Courier](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/apps/courier/Cargo.toml) and [Point](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/apps/point/Cargo.toml) already own separate workspaces and lockfiles. Dispatcher, Box Agent, Control Plane, and Manager are separate packages with their own locks; Box Agent and Control Plane depend on Dispatcher by path.                                                | A unified root workspace is a real migration: preserve Courier's inherited dependencies/lints, choose resolver and lockfile policy, and move member release profiles to the root where required.              |
| Toolchain policy | [Courier pins 1.90](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/apps/courier/rust-toolchain.toml); the other app roots pin 1.96, including [Point](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/apps/point/rust-toolchain.toml). [.agents/setup](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/.agents/setup) installs JS tools and documents lazy app-local Rust installation. | Choose and provision the toolchain used by root Cargo commands; do not assume app-local pins will preserve today's separate CI policy.                                                                        |
| Flutter bridge   | [point_mls](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/apps/point/app/rust/Cargo.toml) deliberately declares a standalone workspace; it produces `cdylib`/`staticlib` artifacts and uses Point core by path. [Flutter CI](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/.github/workflows/point.yml) loads its existing `rust/target/release` output.                                                                | Do not silently pull it into server verification or relocate its outputs. Explicit exclusion/independence and dependency behavior need validation.                                                            |
| CI contracts     | [Main CI](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/.github/workflows/ci.yml) uses `--all-targets`, warning-denying Clippy, Courier workspace builds, system packages, and Manager's opt-in tmux tests. [Point CI](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/.github/workflows/point.yml) supplies PostgreSQL and retains `Swatinem/rust-cache`.                                                                | Default `lint` does not deny warnings or select all targets. Keep explicit command contracts and service setup; do not cache environment-dependent integration tests merely because execution succeeded once. |
| Release boundary | [Point release](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/.github/workflows/point-release.yml) uses `apps/point` as Docker context; [its Dockerfile](https://github.com/PetalNet/monorepo/blob/6c8f04a27caf89dcb3620df39c71bb4c014c1109/apps/point/server/Dockerfile) copies the local workspace manifest/lock and builds to local `target/release`.                                                                                                     | Moving Point into a repository-root workspace requires corresponding Docker context, COPY, output-path, and workflow path-trigger changes.                                                                    |

These consequences follow from the observed manifests/workflows and
[Cargo's workspace rules](https://doc.rust-lang.org/cargo/reference/workspaces.html):
members share one root lockfile and target directory, and only root profiles are
honored. The guide does not advertise discovery of every independent nested
workspace; adding a root manifest must not be mistaken for aggregating existing
virtual workspaces unchanged.

The migration's global `build` outputs are JS-oriented, its `check` depends on
`^typecheck` and `prepare`, and its `test` is uncached by default. Root scripts
already request `build`, `test`, and `check`. Enabling native discovery would
therefore broaden existing root workflow selection. Review the resulting task
graph and Cargo-specific configuration rather than copying the guide's empty
`tasks` example or assuming its zero-configuration defaults match this graph.

## Version finding

**Native `futureFlags.experimentalCargoWorkspaces` exists in released 2.11.7;
it is not restricted to newer or unreleased Turbo.** Evidence:

- The [2.11.7 release](https://github.com/vercel/turborepo/releases/tag/v2.11.7)
  was published on **2026-10-02**.
- The tagged [FutureFlags definition](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-turbo-json/src/future_flags.rs)
  contains `experimental_cargo_workspaces` (camelCase in JSON), describes native
  graph discovery and tasks, and also includes `experimental_task_command`.
- Tagged [Cargo implementation](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-repository/src/cargo.rs)
  and [integration tests](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo/tests/cargo_workspace_test.rs)
  cover discovery, filtered builds, caching/restoration, standalone Cargo
  workspaces, verification, command overrides, and cross-toolchain affectedness.
- The [Rust RFC #13415](https://github.com/vercel/turborepo/discussions/13415)
  states **2.10.6-canary.4 or higher** as its enablement baseline. The
  [corresponding release](https://github.com/vercel/turborepo/releases/tag/v2.10.6-canary.4),
  published **2026-07-18**, lists the experimental Rust guide and crate-scoped
  verification changes. This is the RFC's recommended baseline, not proof of
  the first implementation commit or first stable release containing support.

The [live official guide](https://turborepo.dev/docs/guides/tools/rust) is not
versioned. At review time, its guide text matched the
[2.11.7 guide](https://github.com/vercel/turborepo/blob/v2.11.7/apps/docs/content/docs/guides/tools/rust.mdx)
and upstream main's guide. The Cargo implementation also matched upstream
[main at 081406082912fa515238601a895eecdd595d0f0a](https://github.com/vercel/turborepo/blob/081406082912fa515238601a895eecdd595d0f0a/crates/turborepo-repository/src/cargo.rs)
byte-for-byte. Thus these particular sources do not establish a newer-only
feature; this comparison is not a claim that all main code equals 2.11.7.

## Native behavior and practical boundaries

- **Opt-in and topology:** enable the flag in root `turbo.json`. The guide
  requires root `Cargo.toml`, `[workspace.metadata].name`, root `Cargo.lock`,
  and `cargo`/`rustc` on PATH, and documents a virtual root workspace. Discovery
  is rooted at that manifest, not an advertised recursive discovery of arbitrary
  independent nested Cargo workspaces. A standalone Cargo workspace is supported;
  the RFC still requires npm-ecosystem installation of the Turbo binary.
  The tagged test `test_cargo_root_package_can_be_filtered_and_built` demonstrates
  a root package too, so the guide's virtual-workspace prerequisite is narrower
  than the tested implementation. [Guide and source above.]
- **Tasks and selection:** native verbs are `build`, `run`/`dev`, `test`,
  `check`, `lint` (Clippy), and `format`. Libraries remain graph nodes; unfiltered
  builds prefer entrypoints, falling back to libraries if there are none.
  Unfiltered verification runs once at the synthetic workspace package;
  crate filters select per-crate verification. `run`/`dev` require an entrypoint
  with exactly one binary. Common JS/Rust task names can therefore select both
  ecosystems; the tagged flag documentation supports package `extends: false`
  to exclude defaults. [Tagged FutureFlags, Cargo source, and tests above.]
- **Argument routing matters:** build/check accept Cargo arguments after Turbo's
  `--`; run/test/lint/format insert Cargo's second `--`, forwarding to the
  binary, test harness, Clippy, or rustfmt instead. Cargo-level feature selection,
  exclusions, or nextest are not equivalent to arbitrary passthrough on `test`;
  use an explicit `command` with `experimentalTaskCommand` when necessary.
  [Tagged guide above.]
- **Caching is deliverable caching, not a replacement for Cargo's cache:**
  automatic outputs are exact final `bin`/`cdylib`/`staticlib` artifacts, not
  incremental `target/` state. Library builds and formatting default uncached;
  library `outputs` alone does not enable caching. Supported profile/target
  layouts and in-repository target directories receive automatic output
  detection; unsupported controls or escaping directories fail closed for
  implicit caching. Compiler identity (`rustc -vV`), local dependency source
  closure, Cargo root files, external dependency closure, and relevant environment
  contribute to hashing. Unresolved compiler identity disables implicit caching.
  Build-script environment and extra file inputs still require explicit task
  configuration. [Tagged guide; Cargo source's output-layout tests above.]

## Caveats when interpreting the RFC and docs

The RFC's July comments are questions/reports, **not current guarantees**:

1. A commenter reports locked all-features discovery requiring Rust/private
   dependencies even for JS-only tasks. In 2.11.7, `locked_metadata` still uses
   `cargo metadata --locked --all-features`, so full resolution can need dependency
   access. However, `discover_package_scopes` explicitly performs in-process
   manifest discovery without Cargo/rustc, and full discovery has conservative
   lockfile-resolution fallbacks. Do not repeat the stronger claim that _every_
   JS-only command always requires Rust credentials: the precise CLI path and
   fallback error category need validation. [Tagged Cargo source above.]
2. A commenter reports command overrides discarding Cargo contracts. That is
   not an accurate blanket description of 2.11.7: tagged tests
   `test_cargo_command_override_preserves_native_task_contract` and
   `test_command_override_preserves_native_cache_defaults` explicitly assert
   preservation of native inputs, outputs, hash environment, and defaults.
   This does not prove arbitrary commands produce the inferred artifacts or
   preserve every compile-cache/serialization behavior. [Tagged tests above.]
3. A commenter reports task-only JS/Rust dependencies not propagating package
   affectedness or prune. 2.11.7 documents the separate
   `affectedUsingTaskInputs` future flag and tests
   `test_query_affected_packages_task_inputs_cross_toolchain` and
   `test_prune_task_aware_cross_toolchain_buildable_output`. These cover
   task-aware affectedness and prune across toolchains without manifest edges;
   they do not create a Cargo-to-JS package-manifest dependency or imply identical
   behavior with the flag disabled. [Tagged FutureFlags and tests above.]

4. The guide's custom-task JSON repeats the same `acme-rust` key for both
   examples, rather than distinct package-qualified task keys. Do not copy it:
   duplicate keys can discard the docs command. Verify `acme-rust#docs` and
   `acme-rust#lint` against the pinned binary's task configuration before using
   an override. [Live and tagged guide above.]

## Smallest useful next experiment

Use a disposable fixture with Turbo 2.11.7, a root virtual workspace with
`[workspace.metadata].name`, a root lockfile, one binary, one library, and a
minimal JS package. Enable native discovery before broadening production root
workflows; no `package.json` wrappers are needed for crates.

Before proposing adoption, establish:

1. The dry-run graph selects the expected JS and Rust tasks under the migration's
   root configuration, including filtered versus unfiltered verification.
2. Warning-denying/all-targets Clippy and formatting checks preserve current CI
   behavior; the build/check versus test/lint argument-routing distinction is
   exercised, not assumed.
3. A deleted final binary is restored byte-for-byte from cache; changing a local
   dependency, compiler identity, profile/target, or declared build-script input
   invalidates the right task. Cargo's incremental cache remains separately useful.
4. JS-only commands behave acceptably with Rust unavailable and with offline
   dependency resolution. Broader discovery must not silently defeat the orb's
   lazy-Rust policy.
5. The workspace/toolchain/lockfile ownership decision preserves Point's separate
   Flutter bridge and container build. Keep service-backed and tmux integration
   tests uncached unless their complete execution context can be represented.

**Evidence limits:** this investigation inspected the fetched migration manifests,
configuration and workflows, official docs, release metadata, and tagged source/tests.
It did not execute Cargo through Turbo, run upstream tests, benchmark cache wins,
or verify hosted cache restoration. The first stable release containing support,
precise offline/private-registry behavior, and arbitrary command-override caching
remain unverified. Experimental support is not a stability commitment.
