#!/usr/bin/env bash
# Copy new APKs from GitHub releases into the store and re-sign its index.
# Each line of apps.tsv names a package, the repository that releases it and the
# tag prefix of its releases. A release asset named <package>_<versionCode>.apk
# is taken once, and only when its signing certificate is the one pinned in
# metadata/<package>.yml.
set -uo pipefail
shopt -s extglob

here=$(cd "$(dirname "$0")" && pwd)
store=${APP_STORE_DIR:?Set the store directory}
fdroid=${FDROID:-fdroid}
apksigner=${APKSIGNER:-apksigner}
state=$store/sync-state
# Present from the first change until fdroid update succeeds, so a failed run is retried.
dirty=$state/dirty
mkdir -p "$state" "$store/metadata" "$store/repo" || exit 1
rm -f "$state"/tmp.*

failed=0
fetch() { curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 "$@" </dev/null; }

for file in "$here"/metadata/*.yml; do
	if ! cmp -s "$file" "$store/metadata/${file##*/}"; then
		cp "$file" "$store/metadata/" && touch "$dirty" || failed=1
	fi
done

while IFS=$'\t' read -r package repo prefix || [[ -n ${package-} ]]; do
	[[ -n $package && $package != \#* ]] || continue
	pin=$(sed -n 's/^AllowedAPKSigningKeys: *//p' "$here/metadata/$package.yml" 2>/dev/null)
	if [[ -z $pin ]]; then
		echo "$package: metadata/$package.yml has no AllowedAPKSigningKeys" >&2
		failed=1
		continue
	fi

	# GitHub answers 304 to a matching ETag, and a 304 does not count against the rate limit.
	etag=$state/$package.etag
	list=$(mktemp "$state/tmp.XXXXXX")
	if ! fetch --etag-compare "$etag" --etag-save "$etag.new" -o "$list" \
		-H "Accept: application/vnd.github+json" \
		"https://api.github.com/repos/$repo/releases?per_page=30"; then
		echo "$package: could not list the releases of $repo" >&2
		failed=1
		continue
	fi
	[[ -s $list ]] || continue

	if ! assets=$(jq -r --arg prefix "$prefix" --arg package "$package" '
		.[] | select(.draft | not) | select(.tag_name | startswith($prefix))
		| .assets[] | select(.name | startswith($package + "_") and test("_[0-9]+\\.apk\\z"))
		| [.name, .browser_download_url] | @tsv' "$list"); then
		echo "$package: could not read the release list of $repo" >&2
		failed=1
		continue
	fi

	ok=1
	while IFS=$'\t' read -r name url; do
		[[ -n $name ]] || continue
		[[ $name == "${package}_"*([0-9]).apk ]] || continue
		[[ -e $store/repo/$name || -e $store/archive/$name ]] && continue
		apk=$(mktemp "$state/tmp.XXXXXX")
		if ! fetch -o "$apk" "$url"; then
			echo "$name: download failed" >&2
			ok=0
			continue
		fi
		# apksigner labels a signer "Signer #1" or "V2 Signer:" depending on its version.
		signers=$("$apksigner" verify --print-certs "$apk" </dev/null | grep -v '^Source Stamp' |
			sed -n 's/^.*certificate SHA-256 digest: //p' | sort -u)
		if [[ $signers != "$pin" ]]; then
			echo "$name: signed by ${signers:-nothing}, expected $pin; not published" >&2
			ok=0
			continue
		fi
		touch "$dirty"
		if chmod 644 "$apk" && mv "$apk" "$store/repo/$name"; then
			echo "$name: added"
		else
			ok=0
		fi
	done <<<"$assets"

	# Keep the ETag only when every asset was handled, so a failure is retried.
	if ((ok)); then mv "$etag.new" "$etag"; else failed=1; fi
done <"$here/apps.tsv"

if [[ -e $dirty ]]; then
	if (cd "$store" && "$fdroid" update </dev/null); then rm -f "$dirty"; else failed=1; fi
fi
rm -f "$state"/tmp.* "$state"/*.etag.new
exit "$failed"
