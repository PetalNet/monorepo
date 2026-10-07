# Native Cargo support in Turborepo

Primary-source review and executed adoption checks, 2026-10-07. Native support
uses pinned Turbo 2.11.7 without crate `package.json` wrappers. The Cargo
foundation ([PR #430](https://github.com/PetalNet/monorepo/pull/430)) is merged;
this layer builds on the published selective-CI
[PR #439 head](https://github.com/PetalNet/monorepo/commit/dbe9ac5ce100e558794e81e548c464207b3a4ea3).

**Native discovery is enabled for direct Turbo commands.** The root virtual
workspace supplies the identity, one lockfile, and eleven service crates. The
Flutter bridge stays standalone. See [the workspace contract](./ARCHITECTURE.md#rust-workspace).
Root `pnpm build`, `pnpm test`, `pnpm check`, and `pnpm lint` remain JS-only.
Their shared runner derives a temporary JS configuration from `turbo.json`, changing only
`experimentalCargoWorkspaces` to false: Turbo's affected discovery otherwise
requires Cargo even with a positive JS filter. Native support remains experimental.

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

The shared `build` outputs are JS-oriented and `check` depends on `^typecheck`
and `prepare`. Package-qualified Cargo definitions clear those dependencies and
build outputs; Cargo itself builds dependency closures and Turbo infers exact
native deliverables. Native Clippy overrides retain locked, all-targets,
warning-denying verification and explicit Courier pedantic checks. Native tests
inherit `cache: false`; Manager's filtered tests pass through `N12_TMUX_IT`.
The existing CI Cargo commands and environment setup are unchanged.

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
  than the tested implementation. (Guide and source above.)
- **Tasks and selection:** native verbs are `build`, `run`/`dev`, `test`,
  `check`, `lint` (Clippy), and `format`. Libraries remain graph nodes; unfiltered
  builds prefer entrypoints, falling back to libraries if there are none.
  Unfiltered verification runs once at the synthetic workspace package;
  crate filters select per-crate verification. `run`/`dev` require an entrypoint
  with exactly one binary. Common JS/Rust task names can therefore select both
  ecosystems; the tagged flag documentation supports package `extends: false`
  to exclude defaults. (Tagged FutureFlags, Cargo source, and tests above.)
- **Argument routing matters:** build/check accept Cargo arguments after Turbo's
  `--`; run/test/lint/format insert Cargo's second `--`, forwarding to the
  binary, test harness, Clippy, or rustfmt instead. Cargo-level feature selection,
  exclusions, or nextest are not equivalent to arbitrary passthrough on `test`;
  use an explicit `command` with `experimentalTaskCommand` when necessary.
  (Tagged guide above.)
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
  configuration. (Tagged guide; Cargo source's output-layout tests above.)

## Caveats when interpreting the RFC and docs

The RFC's July comments are questions/reports, **not current guarantees**:

1. A commenter reports locked all-features discovery requiring Rust/private
   dependencies even for JS-only tasks. In 2.11.7, `locked_metadata` still uses
   `cargo metadata --locked --all-features`, so full resolution can need dependency
   access. `discover_package_scopes` performs in-process manifest discovery
   without Cargo/rustc, so ordinary positive-filtered JS dry runs succeeded with
   both absent. However, `--affected` forces authoritative discovery of every
   owner before selection, reproducing `failed to run cargo metadata` even with
   `--filter=@petalnet/*`. The tagged
   [run builder](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-run/src/builder.rs#L672-L706)
   requires the complete graph for affected ranges. Future flags have
   [no environment override](https://github.com/vercel/turborepo/blob/v2.11.7/crates/turborepo-config/src/env.rs#L332-L340),
   and root configurations cannot inherit another root config. The shared JS
   runner is therefore necessary to preserve the orb's lazy-Rust policy.
2. A commenter reports command overrides discarding Cargo contracts. That is
   not an accurate blanket description of 2.11.7: tagged tests
   `test_cargo_command_override_preserves_native_task_contract` and
   `test_command_override_preserves_native_cache_defaults` explicitly assert
   preservation of native inputs, outputs, hash environment, and defaults.
   This does not prove arbitrary commands produce the inferred artifacts or
   preserve every compile-cache/serialization behavior. (Tagged tests above.)
3. A commenter reports task-only JS/Rust dependencies not propagating package
   affectedness or prune. 2.11.7 documents the separate
   `affectedUsingTaskInputs` future flag and tests
   `test_query_affected_packages_task_inputs_cross_toolchain` and
   `test_prune_task_aware_cross_toolchain_buildable_output`. These cover
   task-aware affectedness and prune across toolchains without manifest edges;
   they do not create a Cargo-to-JS package-manifest dependency or imply identical
   behavior with the flag disabled. (Tagged FutureFlags and tests above.)

4. The guide's custom-task JSON repeats the same `acme-rust` key for both
   examples, rather than distinct package-qualified task keys. Do not copy it:
   duplicate keys can discard the docs command. Verify `acme-rust#docs` and
   `acme-rust#lint` against the pinned binary's task configuration before using
   an override. (Live and tagged guide above.)

## Running the two lanes

JS commands and CI planning share `tools/turbo-js.mjs`. It preserves task
settings, environment (including `TURBO_SCM_BASE`/`HEAD`), and Turbo's exit status.
Each invocation owns and removes a unique temporary config, including on failure;
dry-plan stdout contains only Turbo's JSON. The runner selects `@petalnet/*`,
including Whoami. `pnpm check` also selects `//` so repository-wide checks always
run; CI does not make check affected-only.

```sh
pnpm build --affected --dry=json
pnpm test --affected --dry=json
pnpm check --dry=json

# Install Rust lazily before direct native commands in an orb.
mise install --locked rust
pnpm exec turbo run build --filter=agent-manager
pnpm exec turbo run lint test --filter=agent-manager
pnpm exec turbo run format --filter=agent-manager -- --check
N12_TMUX_IT=1 pnpm exec turbo run test --filter=agent-manager -- --ignored
```

Direct unfiltered Turbo commands can select both ecosystems. Unfiltered native
verification runs once through `petalnet-rust`; crate filters run per-crate
verification. Filtering `petalnet-rust` selects workspace verification, not a
workspace build. Point native tests still need PostgreSQL. The aggregate CI's
conservative native fan-out, exact selected-success/unselected-skipped gate,
Postgres setup, Flutter bridge release directory, and opt-in tmux lane remain
unchanged. Security settings activation is separate administrator work, not a
prerequisite for these commands.

## Executed adoption evidence

Checks used the installed 2.11.7 binary in this orb, not upstream test results:

- **Actual graph:** unfiltered build selects seven entrypoints (Manager, Box
  Agent, Control Plane, Courier, Dispatcher, Point core and server); verification
  selects only the synthetic workspace. Dispatcher plus Courier core filters
  select ten per-crate build/test/check/lint/format tasks. Native build outputs
  contain only inferred deliverables, library builds remain uncached, and no
  Flutter `point_mls` package is discovered. Every native test is uncached and
  every Clippy plan retains the all-targets/warning-denying contract. Standalone
  bridge metadata still reports `apps/point/app/rust` as its workspace and
  `apps/point/app/rust/target` as its independent target directory.
- **Actual native execution:** Manager format check and Clippy passed through
  Turbo. Its normal tests passed 46 tests (12 tmux tests ignored); explicit
  opt-in execution passed all 12 tmux tests with cache bypass.
- **Real artifact restoration:** built Manager with `--cache=local:rw`, recorded
  the binary SHA-256, deleted the binary, and reran. Turbo reported `1 cached`
  and `sha256sum -c` reported `OK`.
- **Isolated cache experiment:** a dependency-free fixture had a virtual Cargo
  workspace, one binary, one path library, one JS package and a build script
  reading declared `stamp.txt`. Deleting the entire target directory restored
  byte-identical executable output (`17:alpha`). Changing the library produced
  a hash change, cache miss and `29:alpha`; changing the declared file produced
  another miss and `29:beta`. Custom `ci` profile, explicit host target, and a
  compiler wrapper changing the reported `rustc -vV` commit identity each
  invalidated the hash and executed successfully. These are local-cache and
  simulated compiler-identity checks, not a different installed compiler or
  cross-compilation claim.
- **Lazy Rust and affectedness:** with cargo/rustc absent from PATH and
  `CARGO_NET_OFFLINE=true`, actual `ci-manager select` and the shared runner's
  affected plans passed. Dispatcher edits select every native lane and no JS;
  Flutter-only edits select Point and no JS; Effect API edits select JS including
  its Grove dependent but not unrelated Whoami; root Cargo edits select all
  native lanes and JS. Actual `pnpm build --affected` and `pnpm test --affected`
  for a Whoami-only edit selected one task each and passed (seven tests), with
  both Rust executables absent. The full JS test command passed 507 tests across
  six tasks. The JS graph contains no Cargo commands.
- **Runner isolation:** repeated and four concurrent dry plans produced identical
  task hashes and parseable JSON. All eleven requested root checks and Whoami
  were present. An unknown Turbo task propagated status 1; generated directories
  were removed and the source configuration remained byte-identical.
- **Repository checks:** clean-worktree `pnpm check` passed all 27 tasks, including
  both Knip modes, ESLint, formatting, TypeSync and typechecking. The original
  orb checkout had a pre-existing generated `apps/console` directory without a
  manifest; its TypeSync failure was avoided by verifying a clean worktree, not
  by suppressing the check or removing someone else's generated files.

**Evidence limits:** hosted native artifact caching, private-registry resolution,
upstream test execution, cross-compilation, cache-performance benchmarking, Nix,
and arbitrary custom-command caching are unverified. The existing successful
Cargo/Flutter CI verification is not evidence that this new layer has run hosted.
Experimental support is not a stability commitment.
