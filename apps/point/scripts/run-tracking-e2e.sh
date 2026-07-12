#!/usr/bin/env bash
# Two-account LIVE tracking E2E (Parker's "is tracking working" proof).
#   Account A = the physical phone (real GPS) running track_a_main.dart.
#   Account B = a synthetic client (tests/tracking_e2e.rs, real point_core MLS).
# B must actually RECEIVE A's live positions, and receive NONE once A goes ghost.
#
# Run from apps/point:  scripts/run-tracking-e2e.sh
set -euo pipefail

DEVICE="${DEVICE:-R9WWC0AEE2P}"
SERVER="${SERVER:-http://localhost:8330}"
FIX_COUNT="${FIX_COUNT:-5}"
GHOST_COUNT="${GHOST_COUNT:-2}"
RUNID="r$(date +%s | tail -c 7)"
GHOST_SEQS="$((FIX_COUNT+1)),$((FIX_COUNT+2))"
OUT="/tmp/trackb-${RUNID}.log"

export PATH="$HOME/android-sdk/platform-tools:/home/docker/flutter/bin:$PATH"

echo "== RUNID=$RUNID  server=$SERVER  fixes=$FIX_COUNT  ghost_decoys=$GHOST_COUNT =="

# Phone location must be ON for real GPS.
adb -s "$DEVICE" reverse tcp:8330 tcp:8330 >/dev/null
adb -s "$DEVICE" shell settings put secure location_mode 3 >/dev/null 2>&1 || true

echo "== starting synthetic client B (waits for A) =="
( cd server && RUNID="$RUNID" SERVER_URL="$SERVER" EXPECT_PREGHOST="$FIX_COUNT" \
    GHOST_SEQS="$GHOST_SEQS" DATABASE_URL="postgres://point:point@localhost:5433/point_dev" \
    cargo test -p point-server --test tracking_e2e -- --ignored --nocapture ) \
    > "$OUT" 2>&1 &
B_PID=$!

# Wait for B to register + upload KeyPackages.
for i in $(seq 1 60); do
  grep -q "B READY" "$OUT" && break
  kill -0 "$B_PID" 2>/dev/null || { echo "B exited early:"; cat "$OUT"; exit 1; }
  sleep 1
done
grep -q "B READY" "$OUT" || { echo "B never became READY:"; cat "$OUT"; exit 1; }
echo "   $(grep 'B READY' "$OUT")"

echo "== building + launching A on the phone (RUNID baked in) =="
( cd app && flutter build apk --debug --target=lib/track_a_main.dart \
    --dart-define=RUNID="$RUNID" --dart-define=POINT_SERVER="$SERVER" \
    --dart-define=FIX_COUNT="$FIX_COUNT" --dart-define=GHOST_COUNT="$GHOST_COUNT" \
    >/dev/null 2>&1 )
adb -s "$DEVICE" install -r -g app/build/app/outputs/flutter-apk/app-debug.apk >/dev/null
PKG=dev.petalcat.point_app
adb -s "$DEVICE" shell am force-stop "$PKG"
adb -s "$DEVICE" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "   A launched — producing live GPS fixes"

# Wait for B to reach a verdict (it ends ~12s after the last received fix).
for i in $(seq 1 100); do
  grep -qE "TRACKING-E2E: (PASS|FAIL)|panicked|test result:" "$OUT" && break
  kill -0 "$B_PID" 2>/dev/null || break
  sleep 2
done
wait "$B_PID" 2>/dev/null || true

echo
echo "================= B (synthetic client) OUTPUT ================="
grep -E "B READY|accepted|joined|WS authenticated|B RECV|TRACKING RESULT|received|pre-ghost|post-ghost|TRACKING-E2E|FAIL|panicked" "$OUT" || cat "$OUT"
echo "=============================================================="
echo "(full B log: $OUT ; A screen: capture via adb screencap)"
