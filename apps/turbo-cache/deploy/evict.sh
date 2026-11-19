#!/bin/sh
# Keeps the cache under CACHE_MAX_BYTES, oldest first. An entry's age is the later of its
# mtime and atime: the cache server never rewrites an artifact it serves, so on a mount that
# records reads, atime is the only sign an artifact is still hot, and on a noatime mount the
# write time (mtime) is all there is. Also drops anything idle for CACHE_MAX_AGE_DAYS.
set -eu

max=${CACHE_MAX_BYTES:-42949672960}
low=$((max / 10 * 9))
age_days=${CACHE_MAX_AGE_DAYS:-14}

evict() {
  now=$(date +%s)
  find "$1" -type f -exec stat -c '%X %Y %s %n' {} + |
    awk '{ t = ($1 > $2 ? $1 : $2); p = $0; sub(/^[0-9]+ [0-9]+ [0-9]+ /, "", p); print t "\t" $3 "\t" p }' |
    sort -n -k1,1 |
    awk -F '\t' -v now="$now" -v max="$max" -v low="$low" -v age="$age_days" '
      { t[NR] = $1; s[NR] = $2; p[NR] = $3; sum += $2 }
      END {
        over = sum > max
        for (i = 1; i <= NR; i++) {
          if (t[i] < now - age * 86400 || (over && sum > low)) { print p[i]; sum -= s[i] }
        }
      }' |
    while IFS= read -r file; do
      rm -f -- "$file" && echo "evicted $file"
    done
}

if [ "${1:-}" = --once ]; then
  evict "${2:-/data}"
  exit 0
fi

# A hung or unreachable mount fails one pass; the next pass retries.
while true; do
  evict /data || echo "eviction pass failed" >&2
  sleep "${CACHE_EVICT_INTERVAL_SECONDS:-300}"
done
