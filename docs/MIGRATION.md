# Migration journal

Tracks source repos pulled into this monorepo.

## Method

Each app comes in as its own PR, standard-merged (not squashed) so history is preserved:

1. Clone the source repo locally; `git mv` its contents into `apps/<dest>/` and commit.
2. Add the clone as a remote on the monorepo, `git merge --allow-unrelated-histories`.
3. Flatten any redundant nesting (e.g. `app/web/` → `web/`).
4. Open a PR; merge once CI is green.

Source repos on github.com/PetalNet stay untouched. Rename detection keeps `git log --follow apps/<dest>/...` walking through pre-move paths. (The driver is a local-only script — repo stays shell-script-free.)

## Migrated

_(populated as repos land — see issue #1 for the live checklist)_

## Excluded

- `petalnet-infra`, `ActionOneHass`, `hassblink`, `PetalPVE`, `serverhost` — deployment/infra, stay separate.
- `notes`, `notable-petals` — prototypes.
- `findmy-bridge` — private.
- `homelab-docs` — deferred pending a publishability review.
