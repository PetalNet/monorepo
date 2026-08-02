# Migration journal

This is a partial, historical journal of source repositories pulled into the
monorepo. It records migration-era decisions and gotchas rather than the full
current repository inventory; use the root README and current configuration for
the authoritative layout and commands.

## Method

Each app comes in as its own PR, standard-merged (not squashed) so history is preserved:

1. Clone the source repo locally; `git mv` its contents into `apps/<dest>/` and commit.
2. Add the clone as a remote on the monorepo, `git merge --allow-unrelated-histories`.
3. Flatten any redundant nesting (e.g. `app/web/` → `web/`).
4. Open a PR; merge once CI is green.

Source repos on github.com/PetalNet stay untouched. Rename detection keeps `git log --follow apps/<dest>/...` walking through pre-move paths. (The driver is a local-only script — repo stays shell-script-free.)

## Per-app cleanup + gotchas (learned validating slide)

After the merge, each app needs cleanup commits in this order:

1. Dedupe deps → catalogs, drop the per-app `pnpm-lock.yaml`, relock at the root.
2. Reformat (oxfmt) as its **own** commit, then add that commit's SHA to `.git-blame-ignore-revs`.
3. Fix lints **and** checks as a **separate** commit.

Then, the things that bit slide:

- **Actually run `pnpm --filter <app> build`.** `vp run check` (typecheck + lint + fmt) does **not** run the production build, so build-only failures slip through.
- **Vite 8 / rolldown:** object-form `rollupOptions.output.manualChunks` throws `manualChunks is not a function`. Remove it (let Vite auto-chunk) or use the function form.
- **Prisma apps:** add `prisma generate` to the `build` and `prepare` scripts — the hoisted `@prisma/client` can't find the app's schema, so the build dies with "did not initialize yet". Delete any vestigial `prisma.config.ts` (Prisma 6 syntax) if the app actually runs Prisma 5 (it reads `prisma/schema.prisma` directly).
- **Svelte 5 `state_referenced_locally`:** `data` destructured/read at module top from `$props()` isn't reactive — wrap in `$derived`.
- **Unused deps:** drop whatever knip flags (slide shipped `better-sqlite3` it never imported) and remove the now-orphaned catalog entries.
- **Standalone-repo ops cruft:** PowerShell/shell deploy scripts, Cloudflare-tunnel-per-app setup, and "deploy to a remote box" docs don't belong here (lab routes via Traefik + central deploy). Audit for secrets, then delete; trim the README's deploy section.
- **knip + SvelteKit `$lib` / `./$types` (resolved):** Knip 6.15 historically
  produced false unused-file/dependency reports and failed to resolve generated
  `./$types` imports because of a per-workspace `rootDirs` regression
  (webpro-nl/knip#1778). The workspace now uses Knip 6.16.1 or newer, which
  contains the upstream fix; no local patch is required.

## Migrated

- `courier` → `apps/courier` — reliability-first, from-scratch Rust rewrite and
  drop-in successor to `matrix-bot` (Matrix E2EE relay bot + plugin crates), **not**
  a pnpm app. No `package.json` (pnpm/`vp`/knip ignore it); oxfmt owns
  `.toml`/`.md`, `cargo fmt` owns `.rs`. Its crates remain in their own Cargo
  workspace; `Cargo.lock` is kept for `--locked` validation. CI runs workspace
  fmt, pedantic clippy, all-targets build, and tests with the sqlite/OpenSSL build
  dependencies installed. Dropped standalone Docker/systemd deploy files and
  trimmed deploy docs; lab routing and deployment are central. Full-history,
  all-refs secrets audit found no real secrets.

- `janet-manager` → `apps/manager` — Rust supervisor for a persistent Claude Code
  agent session (manager-rs, N1.1-hardened: heartbeat v2 + contract conformance +
  state-machine tests), **not** a pnpm app. No `package.json` (pnpm/`vp`/knip ignore
  it); oxfmt owns `.toml`/`.md`/`.json`, `cargo fmt` owns `.rs` (first-ever rustfmt
  pass = own blame-ignored commit, ditto the oxfmt pass). Validation is Cargo-native:
  `cargo fmt --check`, `clippy --all-targets --locked -D warnings`, `cargo build
--locked --release`, `cargo test` (21 tests) — all verified in a clean
  `rust:1.96-slim` container; toolchain pinned 1.96 via `rust-toolchain.toml`;
  `Cargo.lock` kept for `--locked`. Dropped standalone cruft (`package.json` +
  superseded `manager.js` baseline — retrievable from imported history). Kept the
  dream2nix flake (build tooling, not deploy cruft) and `docs/contracts/` (the N0.1
  fleet contracts this app implements). No secrets in source or history (token/key
  pattern audit across all blobs: clean).

- `point` → `apps/point` — "Matrix for location": Rust home-server (axum+Postgres) +
  lifted OpenMLS `core` crate + an active Flutter client under `apps/point/app`,
  **not** a pnpm app (no `package.json`; its Rust code has its own Cargo workspace
  and the client has its own Flutter toolchain). Imported mid-build from
  `PetalNet/point` (Fable's v1 build retargeted here by directive, 2026-07-11) with
  full history: seed → M0 scaffolding → wave-A auth. Toolchain pinned 1.96 via
  `rust-toolchain.toml`; validation Cargo-native in `.github/workflows/point.yml`
  (path-filtered: fmt/clippy/build/test against a Postgres 16 service, plus Flutter
  analyze, its Rust bridge build, and Flutter tests). Keeps its AGPL-3.0 LICENSE.
  Source repo stays up (vestigial). The durable build and design record is
  `apps/point/DECISIONS.md`; the completed execution plan was removed.

_(populated as repos land — see issue #1 for the live checklist)_

## Excluded

- `petalnet-infra`, `ActionOneHass`, `hassblink`, `PetalPVE`, `serverhost` — deployment/infra, stay separate.
- `notes`, `notable-petals` — prototypes.
- `findmy-bridge` — private.
- `homelab-docs` — deferred pending a publishability review.
