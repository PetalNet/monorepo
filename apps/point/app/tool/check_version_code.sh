#!/usr/bin/env bash
# R13 — versionCode monotonicity guard. Derives versionName+versionCode from the
# committed pubspec.yaml `version: <name>+<code>` and fails if <code> does not
# strictly exceed the last published code in tool/published_version_code. F-Droid
# (and the Play model) reject a build whose versionCode did not advance; a stale
# or hand-typed --build-number silently produces an un-installable update.
#
# Usage: tool/check_version_code.sh
# Run from apps/point/app. On a successful PUBLISH, bump tool/published_version_code
# to the just-shipped code so the next build must climb past it.
set -euo pipefail

PUBSPEC="pubspec.yaml"
BASELINE_FILE="tool/published_version_code"

version_line="$(grep -E '^version:' "$PUBSPEC" | head -n1)"
version="${version_line#version:}"
version="$(echo "$version" | tr -d '[:space:]')"

name="${version%%+*}"
code="${version##*+}"

if [[ -z "$name" || -z "$code" || "$name" == "$version" ]]; then
  echo "check_version_code: FAIL — pubspec version must be '<name>+<code>', got '$version'" >&2
  exit 1
fi
if ! [[ "$code" =~ ^[0-9]+$ ]]; then
  echo "check_version_code: FAIL — versionCode must be an integer, got '$code'" >&2
  exit 1
fi

baseline=0
if [[ -f "$BASELINE_FILE" ]]; then
  baseline="$(tr -d '[:space:]' < "$BASELINE_FILE")"
  baseline="${baseline:-0}"
fi

if (( code <= baseline )); then
  echo "check_version_code: FAIL — versionCode $code must exceed last published $baseline (pubspec: $version)" >&2
  exit 1
fi

echo "check_version_code: OK — $name build $code (> last published $baseline)"
