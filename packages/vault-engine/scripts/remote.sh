#!/usr/bin/env bash
# Runs a command on another host with every argument shell-quoted, so a URL or a quoted passage
# survives ssh's second parse. stdin and stdout pass through untouched (Loro snapshots are binary).
#
# Usage: remote.sh <host> <command> [args...]
# client.sh uses it to run the vault CLI on the host that holds the vault.
# An unreachable host fails after the connect timeout instead of hanging for minutes.
set -euo pipefail
host=$1
shift
exec ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$(printf '%q ' "$@")"
