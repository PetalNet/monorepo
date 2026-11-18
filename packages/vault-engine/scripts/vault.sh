#!/usr/bin/env bash
# The vault CLI with this host's settings, read from an env file kept outside the repository.
# The file sets VAULT_ROOT and optionally VAULT_CITE and VAULT_PROJECTION, and gives VAULT_AGENT a
# default (write it as VAULT_AGENT=${VAULT_AGENT:-name} so a caller's value wins).
#
# Usage: vault.sh <command> [args...]   (env file: $VAULT_ENV, default ~/.config/vault/env)
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
set -a
# shellcheck disable=SC1090
. "${VAULT_ENV:-$HOME/.config/vault/env}"
set +a
exec node --no-warnings "$SCRIPT_DIR/../src/cli.ts" "$@"
