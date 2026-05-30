# Cutover runbook

When Parker approves, this is the path from "Monorepo exists" to "Monorepo is the source of truth." Estimated 1-2 hours end to end.

> **Pre-flight.** Read `docs/PLAN.md` (canonical spec) and `docs/MIGRATION.md` (what already happened). Confirm:
>
> - You can `pnpm install` in a fresh clone of `Monorepo` without manual fixups.
> - CI is green on `main`.

## 1. Reconcile workspace declarations

Each migrated app brought its own `pnpm-workspace.yaml` and `pnpm-lock.yaml`. The root must be the only owner:

```bash
cd Monorepo
git rm apps/{notes,tasks,petalboard,collegemap,notable-petals}/pnpm-workspace.yaml
git rm apps/clarity/app/web/pnpm-workspace.yaml
git rm apps/{notes,tasks,slide,petalboard,collegemap,notable-petals}/pnpm-lock.yaml
git commit -m "workspaces: root pnpm-workspace.yaml owns everything"
```

If any of those inner workspace files declared additional sub-packages (e.g. `apps/clarity/app/web` is itself a workspace), fold those patterns into the root `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - apps/clarity/app/* # was clarity's own workspace
  - packages/*
  - tools/*
```

## 2. Scope package names

```bash
# For each app's package.json:
#   "name": "slide"        ->  "name": "@petalnet/slide"
#   "name": "map"          ->  "name": "@petalnet/collegemap"
#   etc.
```

Anywhere an app imported one of these by bare name (`import x from "slide"` — unlikely but check), update to `@petalnet/slide`.

## 3. Single root install

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

Resolve any catalog conflicts that surface. Common ones:

- Mismatched ESLint / Vite / TS versions across apps. Bump the loser to match.
- Pinned `pnpm@` versions in apps' `packageManager` field. Remove them — root's wins.

## 4. Build everything

```bash
pnpm check
pnpm build
```

Fix as needed. Most apps should "just work" since their own configs travel with them.

## 5. Deploy stacks

For each app whose Cloudflare / Traefik / Docker compose points at the original `PetalNet/<name>` repo:

- Update the compose file or build pipeline to checkout `PetalNet/Monorepo` and `cd apps/<name>` before building.
- Smoke test each redeployed app at its public URL.

## 6. Flip Monorepo to public

```bash
gh repo edit PetalNet/Monorepo --visibility public --accept-visibility-change-consequences
```

(Or via GitHub UI: Settings → Danger Zone → Change visibility.)

## 7. Archive originals

For each migrated source repo:

```bash
gh repo archive PetalNet/<name>
```

Add a `README.md` redirect on the original pointing at `Monorepo/apps/<name>/`. The archived repos stay readable forever; they just no longer accept pushes.

## 8. Notify

Post in the group room: "Monorepo is live, originals archived, redirect READMEs in place. Holler if anything looks off."

## Rollback

If anything goes sideways before step 7, undo is cheap:

- Monorepo is private + no deploys point at it → just keep iterating on a branch.
- If you've gotten to step 5 and a deploy breaks, revert the compose change and the original repo is still authoritative + deployable.

After step 7 (originals archived), rollback means **unarchiving** the originals (still possible) and reverting the compose changes. The actual data — git history — is preserved both places.
