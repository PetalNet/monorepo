#!/usr/bin/env bash
# Honest cross-instance federation E2E (M3): stand up TWO full Point instances
# (A + B) on separate DBs/ports, a user on each, and drive a live cross-server
# E2E share + encrypted fix. Asserts both servers only ever store ciphertext.
#
# Run from apps/point/server:  ./tests/run-federation-e2e.sh
set -euo pipefail

PG_CONTAINER=point-dev-pg
PG="docker exec $PG_CONTAINER psql -U point"
JWT="fedtestsecretfedtestsecretfedtest123"

free_port() { python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"; }
PORT_A=$(free_port); PORT_B=$(free_port)
DOM_A="127.0.0.1:$PORT_A"; DOM_B="127.0.0.1:$PORT_B"

echo "== building server =="
( cd .. && cargo build -q -p point-server )
BIN=../target/debug/point-server

for db in fed_a fed_b; do
  $PG -d postgres -c "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1 || true
  $PG -d postgres -c "CREATE DATABASE $db" >/dev/null
done

start() { # name db port domain
  DATABASE_URL="postgres://point:point@localhost:5433/$2" \
  JWT_SECRET="$JWT" DOMAIN="$4" PUBLIC_URL="http://$4" \
  OPEN_REGISTRATION=true FEDERATION_ALLOW_PRIVATE=true \
  LISTEN="0.0.0.0:$3" "$BIN" > "/tmp/fed-$1.log" 2>&1 &
  echo $!
}
PID_A=$(start A fed_a "$PORT_A" "$DOM_A")
PID_B=$(start B fed_b "$PORT_B" "$DOM_B")
cleanup() { kill "$PID_A" "$PID_B" 2>/dev/null || true; }
trap cleanup EXIT

for p in "$PORT_A" "$PORT_B"; do
  for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$p/health" >/dev/null && break; sleep 0.5; done
done
echo "A=http://$DOM_A  B=http://$DOM_B"

echo "== running the two-instance E2E =="
export FED_A_URL="http://$DOM_A" FED_B_URL="http://$DOM_B" FED_A_DOM="$DOM_A" FED_B_DOM="$DOM_B"
set +e
( cd .. && DATABASE_URL="postgres://point:point@localhost:5433/point_dev" \
  cargo test -p point-server --test federation_e2e -- --ignored --nocapture )
RC=$?
set -e

echo "== ciphertext-only assertion (both instances) =="
LEAK=0
for db in fed_a fed_b; do
  n=$($PG -d $db -tAc "SELECT
      coalesce((SELECT count(*) FILTER (WHERE encode(encrypted_blob,'escape') ~ 'lat|38\\.6') FROM location_updates),0)
    + coalesce((SELECT count(*) FILTER (WHERE encode(payload,'escape') ~ 'lat|38\\.6') FROM mls_messages),0)")
  echo "  $db plaintext-leak rows: $n"
  LEAK=$((LEAK + n))
done

if [ "$RC" -eq 0 ] && [ "$LEAK" -eq 0 ]; then
  echo "FEDERATION-E2E: PASS (cross-instance E2E share, both servers ciphertext-only)"
else
  echo "FEDERATION-E2E: FAIL (rc=$RC leaks=$LEAK)"; exit 1
fi
