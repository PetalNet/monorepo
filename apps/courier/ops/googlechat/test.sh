#!/usr/bin/env bash
set -euo pipefail

fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
expected="$PWD/consumer-cookie-rotation.patch"
cp ./*.py "$fixture/"
cp -R fixtures "$fixture/"
cd "$fixture"
git init -q sources/upstream
git -C sources/upstream fetch --depth=1 https://github.com/mautrix/googlechat.git a835bccd269eace6c28196a3f869eb1fb3c8acf7
git -C sources/upstream checkout -q --detach FETCH_HEAD
python -B build_patch.py
cmp "$expected" consumer-cookie-rotation.patch
python -B -m unittest -v test_importer test_rotation test_submit
