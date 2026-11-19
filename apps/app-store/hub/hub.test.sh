#!/usr/bin/env bash
# Behaviour check for hub.sh: nothing from the private /store repo may reach the hub output.
# Run: apps/app-store/hub/hub.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$work/public" "$work/store/repo"
cat >"$work/public/index-v1.json" <<'JSON'
{"repo":{"address":"https://fdroid.petalcat.dev/repo"},
 "apps":[{"packageName":"com.pub.app","name":"Public App","summary":"Open"}],
 "packages":{"com.pub.app":[{"apkName":"pub-1.apk","versionName":"1.0","versionCode":1,"size":1048576,"added":1785094081000}]}}
JSON
cat >"$work/store/repo/index-v1.json" <<'JSON'
{"repo":{"address":"https://fdroid.petalcat.dev/store/repo"},
 "apps":[{"packageName":"com.secret.app","name":"Secret App","summary":"Private"}],
 "packages":{"com.secret.app":[{"apkName":"secret_1.apk","versionName":"9.9","versionCode":9,"size":1048576,"added":1785094081000}]}}
JSON

# The shipped config, with the store index sitting right next to the public one.
APP_STORE_DIR=$work/store PUBLIC_REPO_DIR=$work/public HUB_DIR=$work/out HUB_CONFIG=$work/ship.json \
	jq '.apps = [{slug: "pub", package: "com.pub.app", repo: "repo"}]' "$here/hub.json" >"$work/ship.json"
APP_STORE_DIR=$work/store PUBLIC_REPO_DIR=$work/public HUB_DIR=$work/out HUB_CONFIG=$work/ship.json "$here/hub.sh"
[[ -L $work/out/apps/pub/download/pub.apk ]] || fail "the public app was not published"
if grep -rIl -e "Secret App" -e "com.secret.app" -e "secret_1" -e "/store" "$work/out" >/dev/null; then
	fail "store content reached the hub output"
fi
[[ $(jq -r '.[].id' "$work/out/api/apps.json") == pub ]] || fail "/api/apps lists more than the public app"

# Pointing an app at the store repo must stop the build instead of publishing it.
jq '.apps += [{slug: "secret", package: "com.secret.app", repo: "store"}]' "$work/ship.json" >"$work/leak.json"
if APP_STORE_DIR=$work/store PUBLIC_REPO_DIR=$work/public HUB_DIR=$work/out2 HUB_CONFIG=$work/leak.json "$here/hub.sh" 2>/dev/null; then
	fail "an app from the store repo was accepted"
fi
[[ ! -e $work/out2/apps/secret ]] || fail "the store app was linked"

echo "ok"
