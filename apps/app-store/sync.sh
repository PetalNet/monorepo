#!/usr/bin/env bash
# Copy new APKs from GitHub releases into the store and re-sign its index.
# Each line of apps.tsv names a package, the repository that releases it and the
# tag prefix of its releases. A release asset named <package>_<versionCode>.apk
# is taken once, and only when its signing certificate is the one pinned in
# metadata/<package>.yml.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
store=${APP_STORE_DIR:?Set the store directory}
fdroid=${FDROID:-fdroid}
apksigner=${APKSIGNER:-apksigner}
state=$store/sync-state
mkdir -p "$state" "$store/metadata" "$store/repo"

changed=0
failed=0

for file in "$here"/metadata/*.yml; do
	if ! cmp -s "$file" "$store/metadata/${file##*/}"; then
		cp "$file" "$store/metadata/"
		changed=1
	fi
done

while IFS=$'\t' read -r package repo prefix; do
	[[ -n $package && $package != \#* ]] || continue
	pin=$(sed -n 's/^AllowedAPKSigningKeys: *//p' "$here/metadata/$package.yml")
	[[ -n $pin ]] || { echo "$package: no AllowedAPKSigningKeys in its metadata" >&2; failed=1; continue; }

	# GitHub answers 304 to a matching ETag, and a 304 does not count against the rate limit.
	etag=$state/$package.etag
	list=$(mktemp)
	curl -fsS --retry 3 --etag-compare "$etag" --etag-save "$etag.new" -o "$list" \
		-H "Accept: application/vnd.github+json" \
		"https://api.github.com/repos/$repo/releases?per_page=30"
	if [[ ! -s $list ]]; then
		rm -f "$list" "$etag.new"
		continue
	fi

	ok=1
	while IFS=$'\t' read -r name url; do
		[[ -e $store/repo/$name || -e $store/archive/$name ]] && continue
		apk=$(mktemp)
		curl -fsSL --retry 3 -o "$apk" "$url"
		signer=$("$apksigner" verify --print-certs "$apk" |
			sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
		if [[ $signer != "$pin" ]]; then
			echo "$name: signed by ${signer:-nothing}, expected $pin; not published" >&2
			rm -f "$apk"
			ok=0
			continue
		fi
		chmod 644 "$apk"
		mv "$apk" "$store/repo/$name"
		echo "$name: added"
		changed=1
	done < <(jq -r --arg prefix "$prefix" --arg package "$package" '
		.[] | select(.draft | not) | select(.tag_name | startswith($prefix))
		| .assets[] | select(.name | test("^" + $package + "_[0-9]+\\.apk$"))
		| [.name, .browser_download_url] | @tsv' "$list")
	rm -f "$list"

	# Keep the ETag only when every asset was handled, so a failure is retried.
	if ((ok)); then mv "$etag.new" "$etag"; else rm -f "$etag.new"; failed=1; fi
done <"$here/apps.tsv"

if ((changed)); then
	(cd "$store" && "$fdroid" update)
fi
exit "$failed"
