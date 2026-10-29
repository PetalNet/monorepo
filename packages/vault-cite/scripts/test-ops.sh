#!/usr/bin/env bash
# Exercises run.sh/worker.sh against mocked systemd-run and a scratch sqlite store,
# without touching the real cite backend, Chromium or network.
#
# Test 1: systemd-run always fails. run.sh must stop with a nonzero exit instead of
#         logging DONE and exiting 0 (the exit-status-swallowed-by-stamp bug).
# Test 2: a derivation is leased (state=RUNNING) and never finishes. The drain loop
#         must stay alive waiting for it instead of treating the queue as drained
#         (the pending() bug that ignored RUNNING derivations).
# Test 3: worker.sh records a failed work batch explicitly (an explicit "FAILED"
#         log line), rather than silently logging it as if it had succeeded.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad() {
	printf 'FAIL: %s\n' "$1"
	fail=1
}

mock_bin() {
	# mock_bin <dir> <systemd-run exit code>
	mkdir -p "$1"
	cat >"$1/systemd-run" <<EOF
#!/bin/sh
exit $2
EOF
	chmod +x "$1/systemd-run"
}

sqlite_store() {
	# sqlite_store <root> <derivation state, or empty for none>
	mkdir -p "$1"
	python3 - "$1" "$2" <<'PYEOF'
import sqlite3
import sys

root, state = sys.argv[1], sys.argv[2]
db = sqlite3.connect(f"{root}/index-v2.sqlite")
db.execute("CREATE TABLE jobs(state TEXT)")
db.execute("CREATE TABLE derivations(state TEXT)")
if state:
	db.execute("INSERT INTO derivations VALUES (?)", (state,))
db.commit()
db.close()
PYEOF
}

# --- Test 1: enqueue failure must stop the run -----------------------------
t1_bin=$TMP/t1-bin
t1_root=$TMP/t1-root
mock_bin "$t1_bin" 1
sqlite_store "$t1_root" ""

PATH="$t1_bin:$PATH" CITE_ROOT="$t1_root" CSV=/dev/null LOG=/dev/null FLOOR_GIB=0 \
	bash "$SCRIPT_DIR/run.sh" >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
	pass "run.sh exits nonzero ($rc) when the enqueue call fails"
else
	bad "run.sh exited 0 despite every systemd-run call failing"
fi

# --- Test 2: a leased (RUNNING) derivation must keep the drain loop alive --
t2_bin=$TMP/t2-bin
t2_root=$TMP/t2-root
mock_bin "$t2_bin" 0
sqlite_store "$t2_root" "RUNNING"

timeout 3 env PATH="$t2_bin:$PATH" CITE_ROOT="$t2_root" CSV=/dev/null LOG=/dev/null FLOOR_GIB=0 \
	bash "$SCRIPT_DIR/run.sh" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 124 ]; then
	pass "drain loop stays alive (timed out) while a derivation is still RUNNING"
else
	bad "drain loop exited (rc=$rc) while a derivation was still RUNNING/leased"
fi

# --- Test 3: worker.sh records a failed batch explicitly -------------------
t3_bin=$TMP/t3-bin
t3_root=$TMP/t3-root
t3_log=$TMP/t3.log
mock_bin "$t3_bin" 1
sqlite_store "$t3_root" ""

PATH="$t3_bin:$PATH" CITE_ROOT="$t3_root" LOG="$t3_log" FLOOR_GIB=0 \
	bash "$SCRIPT_DIR/worker.sh" 1 >/dev/null 2>&1

if grep -q 'work FAILED' "$t3_log" 2>/dev/null; then
	pass "worker.sh logs a failed work batch explicitly"
else
	bad "worker.sh did not record the failed work batch"
fi

exit "$fail"
