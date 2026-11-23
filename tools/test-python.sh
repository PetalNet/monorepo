#!/usr/bin/env bash
set -euo pipefail

# Turbo can run multiple members at once. uv's default .venv is shared by the whole workspace.
export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$PWD/.venv}"
sync_args=()
while [[ "$1" != -- ]]; do
  sync_args+=("$1")
  shift
done
shift

uv sync --locked "${sync_args[@]}"
exec uv run --no-sync "$@"
