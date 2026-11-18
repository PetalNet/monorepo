#!/usr/bin/env bash
# One vault-cite call, capped and serialized, for capture-on-cite from the vault engine.
# A page render can balloon, so the call runs as a transient user service inside a 2G cgroup with
# no swap and a 15 min limit, and a lock keeps captures to one at a time on the host.
#
# Usage: cite-one.sh add <ref> | get <ref> | search <query> | status
# Env vars: CITE_ROOT (source store; required), CITE_WORKDIR (cwd for the disk guard, default
# $CITE_ROOT), CITE_CHROMIUM_EXECUTABLE (autodetected from the Playwright cache when unset).
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CITE=$(cd "$SCRIPT_DIR/../../vault-cite" && pwd)
: "${CITE_ROOT:?set CITE_ROOT to the source store}"
export CITE_ROOT
export CITE_CHROMIUM_EXECUTABLE=${CITE_CHROMIUM_EXECUTABLE:-$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | head -1)}
exec flock "$CITE_ROOT/.capture.lock" \
	systemd-run --user --quiet --wait --pipe --collect \
	-p MemoryMax=2G -p MemorySwapMax=0 -p RuntimeMaxSec=15min \
	--working-directory="${CITE_WORKDIR:-$CITE_ROOT}" -E CITE_ROOT -E CITE_CHROMIUM_EXECUTABLE \
	"$(command -v node)" --no-warnings "$CITE/src/cli.ts" "$@"
