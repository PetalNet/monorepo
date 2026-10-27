#!/usr/bin/env bash
# Extra drain worker for the Part B backfill; claims share leases and pacing with run.sh.
# Resumable Part B backfill. The cite jobs table in index-v2.sqlite is the manifest;
# rerunning this script enqueues nothing twice and continues with due jobs.
#
# Usage: worker.sh <id>
# Env vars: same as run.sh (CITE_ROOT, CITE_CHROMIUM_EXECUTABLE, PKG, LOG, FLOOR_GIB).
set -uo pipefail
WORKER=${1:?worker id}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG=${PKG:-$(cd "$SCRIPT_DIR/.." && pwd)}

export CITE_ROOT=${CITE_ROOT:-/home/docker/vault-data/sources}
export CITE_CHROMIUM_EXECUTABLE=${CITE_CHROMIUM_EXECUTABLE:-$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | head -1)}
LOG=${LOG:-$CITE_ROOT/backfill/run.log}
# Each CLI call runs as its own transient user service: a runaway renderer is OOM-killed
# inside its 2G cgroup instead of the host, no swap is used, a hung batch is stopped after
# 2h, and leftover Chromium children die with the unit.
CLI=(systemd-run --user --quiet --wait --pipe --collect
	-p MemoryMax=2G -p MemorySwapMax=0 -p RuntimeMaxSec=2h
	--working-directory="${CITE_WORKDIR:-$PKG}" -E CITE_ROOT -E CITE_CHROMIUM_EXECUTABLE
	"$(command -v node)" --no-warnings "$PKG/src/cli.ts")
FLOOR_GIB=${FLOOR_GIB:-36}
cd "$PKG" || exit 1

stamp() { printf '%s w%s %s\n' "$(date -Is)" "$WORKER" "$*" >>"$LOG"; }
free_gib() { df --output=avail -B1G / | tail -1 | tr -d ' '; }

pending() {
	python3 - <<EOF
import sqlite3
db = sqlite3.connect("file:${CITE_ROOT}/index-v2.sqlite?mode=ro", uri=True)
print(db.execute("SELECT count(*) FROM jobs WHERE state IN ('QUEUED','RUNNING')").fetchone()[0]
      + db.execute("SELECT count(*) FROM derivations WHERE state='PENDING'").fetchone()[0])
EOF
}

drain() {
	while :; do
		if [ "$(free_gib)" -lt "$FLOOR_GIB" ]; then
			stamp "STOP free $(free_gib)G below ${FLOOR_GIB}G floor"
			exit 3
		fi
		stamp "work $("${CLI[@]}" work 50 | tr '\n' ' ')"
		left=$(pending)
		stamp "pending=$left free=$(free_gib)G"
		[ "$left" -eq 0 ] && return
		# Due jobs ran; what remains waits on backoff or domain pacing.
		sleep 20
	done
}

stamp "START free=$(free_gib)G"
drain
stamp "DONE free=$(free_gib)G"
