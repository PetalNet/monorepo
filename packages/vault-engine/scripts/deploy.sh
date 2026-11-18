#!/usr/bin/env bash
# Installs the vault engine from origin/main into its own release directory and points `current`
# at it. Nothing is built in the live directory: a release is complete before the switch.
#
# Usage: deploy.sh <local monorepo clone> [install root]
# The clone is only fetched and read. The install root defaults to ~/.local/share/vault-engine.
set -euo pipefail
clone=${1:?usage: deploy.sh <local monorepo clone> [install root]}
root=${2:-$HOME/.local/share/vault-engine}

git -C "$clone" fetch --quiet origin main
sha=$(git -C "$clone" rev-parse FETCH_HEAD)
release="$root/releases/$sha"

if [ ! -e "$release/.installed" ]; then
	mkdir -p "$root/releases"
	rm -rf "$release"
	git -C "$clone" worktree prune
	git -C "$clone" worktree add --quiet --detach "$release" "$sha"
	# The repository pins its pnpm; a different major rewrites the lockfile's peer suffixes.
	pnpm=$(cd "$release" && node -p "require('./package.json').packageManager")
	(cd "$release" && corepack "$pnpm" install --frozen-lockfile --prefer-offline --ignore-scripts \
		--filter '@petalnet/vault-engine...' --filter '@petalnet/vault-cite...')
	# The release must load: every module and dependency resolves before the switch.
	(cd "$release/packages/vault-engine" && node --no-warnings src/cli.ts --version >/dev/null)
	touch "$release/.installed"
fi

ln -sfn "$release" "$root/current.new"
mv -T "$root/current.new" "$root/current"
echo "$sha"

# Keep the live release and the two newest others.
kept=0
for old in $(ls -1dt "$root"/releases/*/); do
	[ "$(readlink -f "$old")" = "$(readlink -f "$root/current")" ] && continue
	kept=$((kept + 1))
	[ "$kept" -le 2 ] && continue
	git -C "$clone" worktree remove --force "$old" 2>/dev/null || rm -rf "$old"
done
