#!/bin/sh
set -eu
# This named directory belongs exclusively to this test harness.
test "${BOOTH_DATA:-}" = '.cache/browser-recordings'
test "${ORIGIN:-}" = 'http://127.0.0.1:18806'
rm -rf .cache/browser-recordings
mkdir -p .cache/browser-recordings
node build &
booth_server_pid=$!
printf '%s\n' "$booth_server_pid" > .cache/browser-server.pid
trap 'kill "$booth_server_pid" 2>/dev/null || true' INT TERM
wait "$booth_server_pid"
