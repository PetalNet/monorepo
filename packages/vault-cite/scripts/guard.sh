#!/usr/bin/env bash
# Runs worker.sh 1 until the queue drains, pausing it on real memory pressure: memory PSI some avg10 > 10,
# swap-in > 500 pages/s for 3 samples in a row, MemAvailable < 4 GiB, or load > 40. A pause stops the
# worker loop, then its unit; the worker resumes after 2 min of clean samples.
#
# Env vars: CITE_ROOT (storage root, same default as the package itself), LOG (run log
# path, defaults under CITE_ROOT), OUT (worker stdout/stderr log, defaults next to this
# script).
set -u
CITE_ROOT=${CITE_ROOT:-/home/docker/vault-data/sources}
LOG=${LOG:-$CITE_ROOT/backfill/run.log}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=${OUT:-$SCRIPT_DIR/guard-worker1.out}
cd "$SCRIPT_DIR" || exit 1
note() { printf '%s guard %s\n' "$(date -Is)" "$*" >>"$LOG"; }
psi() { awk 'NR==1{split($2,a,"=");printf "%d",a[2]}' /proc/pressure/memory; }
avail_gib() { awk '/MemAvailable/{printf "%d",$2/1048576}' /proc/meminfo; }
load() { cut -d' ' -f1 /proc/loadavg | cut -d. -f1; }
pswpin() { awk '/^pswpin/{print $2}' /proc/vmstat; }
prev=$(pswpin) si=0 hot=0
sample() {
	local now
	now=$(pswpin)
	si=$(((now - prev) / 30))
	prev=$now
	if [ "$si" -gt 500 ]; then hot=$((hot + 1)); else hot=0; fi
	state="psi=$(psi) si=${si}/s avail=$(avail_gib)G load=$(load)"
	[ "$(psi)" -le 10 ] && [ "$hot" -lt 3 ] && [ "$(avail_gib)" -ge 4 ] && [ "$(load)" -le 40 ]
}
stop_worker() {
	kill "$1" 2>/dev/null
	sleep 2
	for u in $(systemctl --user list-units --type=service --state=running --plain --no-legend | awk '/^run-/{print $1}'); do
		systemctl --user show -p ExecStart "$u" | grep -q "cli.ts work" && systemctl --user stop "$u"
	done
}
while :; do
	ok=0
	while [ "$ok" -lt 4 ]; do
		sleep 30
		if sample; then ok=$((ok + 1)); else ok=0; fi
	done
	FLOOR_GIB=30 CITE_WORKDIR="${CITE_WORKDIR:-$CITE_ROOT/backfill}" setsid bash "$SCRIPT_DIR/worker.sh" 1 >>"$OUT" 2>&1 </dev/null &
	W=$!
	echo "$W" >"$SCRIPT_DIR/worker1.pid"
	note "started worker.sh 1 pid=$W $state"
	paused=0
	while kill -0 "$W" 2>/dev/null; do
		sleep 30
		if ! sample; then
			note "PAUSE $state: stopping worker loop $W, then its unit"
			stop_worker "$W"
			paused=1
			break
		fi
	done
	if [ "$paused" -eq 0 ]; then
		wait "$W"
		note "worker exited code=$? $state"
		exit 0
	fi
done
