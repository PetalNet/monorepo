# Migration journal

Tracks source repos pulled into this monorepo.

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
- **Open issue:** knip doesn't resolve a SvelteKit app's `$lib` alias under the monorepo workspace config → false "unused file/dependency" on `src/lib/**` and their deps (e.g. `@prisma/client`). collegemap resolves fine; cause TBD.

## Migrated

_(populated as repos land — see issue #1 for the live checklist)_

## Excluded

- `petalnet-infra`, `ActionOneHass`, `hassblink`, `PetalPVE`, `serverhost` — deployment/infra, stay separate.
- `notes`, `notable-petals` — prototypes.
- `findmy-bridge` — private.
- `homelab-docs` — deferred pending a publishability review.
