#!/usr/bin/env bash
set -euo pipefail

# Turbo can run multiple members at once. uv's default .venv is shared by the whole workspace.
export UV_PROJECT_ENVIRONMENT="$PWD/.venv"
if [[ -n "${UV_TEST_ENVIRONMENTS:-}" ]]; then
  workspace=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
  UV_PROJECT_ENVIRONMENT="$UV_TEST_ENVIRONMENTS/${PWD#"$workspace"/}"
fi
sync_args=()
while [[ "$1" != -- ]]; do
  sync_args+=("$1")
  shift
done
shift

uv sync --locked "${sync_args[@]}"
exec uv run --no-sync "$@"
