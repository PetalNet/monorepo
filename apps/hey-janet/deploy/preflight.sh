#!/bin/sh
set -eu
# Read-only preflight. Janet runs this before any apply.
mountpoint -q /services || { echo '/services is not mounted; refusing local-disk fallback'; exit 1; }
findmnt -rn -M /services -o SOURCE | grep -Fx '10.10.10.12:/mnt/JeremyBearimy/Backups/Services' >/dev/null || { echo 'Unexpected NAS mount'; exit 1; }
test -d /services/hey-janet/recordings
test -w /services/hey-janet/recordings
if ss -ltnH 'sport = :8806' | grep -q .; then echo 'Port 8806 is occupied; inspect before apply'; exit 1; fi
echo 'NAS mount and port checks passed.'
