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
pending() { python3 "$SCRIPT_DIR/pending.py"; }

# Runs the CLI pipeline and echoes its tr'd output, but returns the CLI's own
# exit status instead of tr's: with pipefail set, $? after an `out=$(a | b)`
# assignment already reflects that, so capture it immediately, before the
# output is handed to `stamp`, or it is lost.
cli_run() {
	local out rc
	out=$("${CLI[@]}" "$@" | tr '\n' ' ')
	rc=$?
	printf '%s' "$out"
	return "$rc"
}

drain() {
	while :; do
		if [ "$(free_gib)" -lt "$FLOOR_GIB" ]; then
			stamp "STOP free $(free_gib)G below ${FLOOR_GIB}G floor"
			exit 3
		fi
		local work_out rc
		work_out=$(cli_run work 50)
		rc=$?
		if [ "$rc" -ne 0 ]; then
			# A batch failing does not drain the queue; leases expire and due jobs
			# are retried on the next loop iteration, so keep looping.
			stamp "work FAILED rc=$rc $work_out"
		else
			stamp "work $work_out"
		fi
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
