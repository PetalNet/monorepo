#!/bin/sh
# Keeps the cache under CACHE_MAX_BYTES, oldest first. An entry's age is the later of its
# mtime and atime: the cache server never rewrites an artifact it serves, so on a mount that
# records reads, atime is the only sign an artifact is still hot, and on a noatime mount the
# write time (mtime) is all there is. Also drops anything idle for CACHE_MAX_AGE_DAYS.
set -eu

max=${CACHE_MAX_BYTES:-42949672960}
low=$((max / 10 * 9))
age_days=${CACHE_MAX_AGE_DAYS:-14}
# Optional JSON status for the exchanger's home page; written atomically after each pass.
status=${CACHE_STATUS_FILE:-}

evict() {
  now=$(date +%s)
  last=null
  if [ -n "$status" ]; then rm -f "$status.tmp"; fi
  if [ -n "$status" ] && [ -f "$status" ]; then
    last=$(sed -n 's/.*"last_eviction":\([0-9][0-9]*\).*/\1/p' "$status")
    last=${last:-null}
  fi
  find "$1" -type f -exec stat -c '%X %Y %s %n' {} + |
    awk '{ t = ($1 > $2 ? $1 : $2); p = $0; sub(/^[0-9]+ [0-9]+ [0-9]+ /, "", p); print t "\t" $3 "\t" p }' |
    sort -n -k1,1 |
    awk -F '\t' -v now="$now" -v max="$max" -v low="$low" -v age="$age_days" \
      -v status="${status:+$status.tmp}" -v previous="$last" '
      { t[NR] = $1; s[NR] = $2; p[NR] = $3; sum += $2 }
      END {
        over = sum > max
        files = NR
        for (i = 1; i <= NR; i++) {
          if (t[i] < now - age * 86400 || (over && sum > low)) {
            print p[i]; sum -= s[i]; files--; gone++; gone_bytes += s[i]
          }
        }
        if (status != "" && NR > 0) {
          printf "{\"updated\":%d,\"files\":%d,\"bytes\":%d,\"max_bytes\":%d,\"evicted_files\":%d,\"evicted_bytes\":%d,\"last_eviction\":%s}\n", \
            now, files, sum, max, gone, gone_bytes, (gone > 0 ? now : previous) > status
        }
      }' |
    while IFS= read -r file; do
      rm -f -- "$file" && echo "evicted $file"
    done
  if [ -n "$status" ] && [ -f "$status.tmp" ]; then
    mv -f "$status.tmp" "$status"
  fi
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
