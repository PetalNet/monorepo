#!/bin/sh
set -eu

if [ "${1:-}" = --once ]; then
  exec find "${2:-/data}" -type f -atime +13 -exec rm -- {} +
fi

while true; do
  now=$(date +%s)
  next=$((now / 86400 * 86400 + 10800))
  if [ "$next" -le "$now" ]; then next=$((next + 86400)); fi
  sleep "$((next - now))"
  sh "$0" --once /data
done
