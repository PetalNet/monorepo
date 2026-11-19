#!/usr/bin/env bash
# Build app.petalcat.dev from the two F-Droid indexes: the page, /api/apps and the
# direct-download paths. The indexes are the single source of truth for what each
# app is and which APK is current; nothing here copies an APK.
# Re-running with nothing changed rewrites the same files.
set -euo pipefail
shopt -s extglob

here=$(cd "$(dirname "$0")" && pwd)
store=${APP_STORE_DIR:?Set the store directory}
public=${PUBLIC_REPO_DIR:-/home/docker/fdroid/repo}
out=${HUB_DIR:-$store/hub}
config=$here/hub.json

empty='{"apps":[],"packages":{}}'
# The public repo is hand-published; a missing index means a bad mount, so keep the old hub.
# The store has no index until fdroid update has run once.
index() {
	if [[ -r $1/index-v1.json ]]; then cat "$1/index-v1.json"; else
		[[ $2 == optional ]] || { echo "hub: no index in $1, leaving the hub as it was" >&2; exit 1; }
		echo "$empty"
	fi
}
declare -A dirs=([repo]=$public [store]=$store/repo)

mkdir -p "$out/api/apps" "$out/apps"

# Write through a temp file so nginx never serves a half-written file.
put() {
	local tmp
	tmp=$(mktemp "$(dirname "$1")/.tmp.XXXXXX")
	cat >"$tmp"
	[[ -s $tmp ]] || { rm -f "$tmp"; echo "hub: refusing to publish an empty $1" >&2; exit 1; }
	chmod 644 "$tmp"
	mv -f "$tmp" "$1"
}
# Link inside the container's view of the repo: the target resolves under nginx, not on the host.
link() {
	local tmp
	mkdir -p "$(dirname "$2")"
	tmp=$(mktemp -u "$(dirname "$2")/.tmp.XXXXXX")
	ln -s "$1" "$tmp"
	mv -fT "$tmp" "$2"
}

records=$(jq -n \
	--slurpfile config "$config" \
	--slurpfile repo <(index "${dirs[repo]}" required) \
	--slurpfile store <(index "${dirs[store]}" optional) '
	{repo: $repo[0], store: $store[0]} as $index
	| $config[0] as $c
	| [ $c.apps[] | . as $app
		| $c.repos[$app.repo] as $r
		| $index[$app.repo] as $ix
		| ($ix.apps[]? | select(.packageName == $app.package)) as $meta
		| ($ix.packages[$app.package] // [] | max_by(.versionCode)) as $pkg
		| select($pkg != null)
		| {
			id: $app.slug,
			name: ($meta.name // $app.slug),
			package: $app.package,
			repo: $app.repo,
			private: $r.private,
			version: $pkg.versionName,
			versionCode: $pkg.versionCode,
			size: $pkg.size,
			updated: (($meta.lastUpdated // $pkg.added) / 1000 | strftime("%Y-%m-%d %H:%M:%S")),
			summary: ($meta.summary // ""),
			web_url: $meta.webSite,
			apk: $pkg.apkName,
			icon: (if $meta.localized["en-US"].icon then "\($app.package)/en-US/\($meta.localized["en-US"].icon)" else null end),
			mount: $r.mount,
			iconDir: $r.dir,
			download_url: (if $r.private then null else "/apps/\($app.slug)/download/\($app.slug).apk" end),
			fdroid_url: "fdroidrepos://\($ix.repo.address | sub("^https://"; ""))?fingerprint=\($r.fingerprint)"
		} ]')

# Direct downloads and icons: stable paths that point at the repo files.
# A private repo is never linked, so its APKs stay behind the store login.
icons=()
while IFS=$'\t' read -r slug mount apk icon dir; do
	link "$mount/$apk" "$out/apps/$slug/download/$slug.apk"
	if [[ $icon != - && -e ${dirs[$dir]}/$icon ]]; then
		link "$mount/$icon" "$out/apps/$slug/icon.png"
		icons+=("$slug")
	else
		rm -f "$out/apps/$slug/icon.png"
	fi
done < <(jq -r '.[] | select(.private | not)
	| [.id, .mount, .apk, (.icon // "-"), .repo] | @tsv' <<<"$records")

with_icons=$(jq -n '$ARGS.positional' --args "${icons[@]}")
page_records=$(jq --argjson icons "$with_icons" '[.[]
	| .icon_url = (if .id as $id | $icons | index($id) then "/apps/\(.id)/icon.png" else null end)
	| del(.mount, .iconDir, .apk, .icon)]' <<<"$records")

api=$(jq '[.[] | del(.icon_url)]' <<<"$page_records")
put "$out/api/apps.json" <<<"$api"
while IFS= read -r app; do
	one=$(jq 'del(.icon_url)' <<<"$app")
	put "$out/api/apps/$(jq -r .id <<<"$app").json" <<<"$one"
done < <(jq -c '.[]' <<<"$page_records")

# Drop what the current indexes no longer list, so a removed app stops being served.
keep=$(jq -r '.[].id' <<<"$records" | paste -sd'|')
for path in "$out"/apps/* "$out"/api/apps/*.json; do
	slug=$(basename "$path" .json)
	[[ $slug == @($keep) ]] || rm -rf "$path"
done

host=$(jq -r .host "$config")
page=$(jq -nr \
	--rawfile template "$here/index.html" \
	--arg host "$host" \
	--argjson apps "$page_records" '
	def card:
		(if .private | not then .download_url else null end) as $direct
		| @html "<li class=\"app\">"
		+ "<div class=\"app-head\"><span class=\"app-icon\">"
		+ (if .icon_url then @html "<img src=\"\(.icon_url)\" alt=\"\" width=\"48\" height=\"48\">"
			else @html "\(.name[0:1] | ascii_upcase)" end)
		+ @html "</span><div><h2>\(.name)</h2><p class=\"app-meta\">v\(.version) · \(.size / 104857.6 | round / 10) MB · \(.updated | strptime("%Y-%m-%d %H:%M:%S") | mktime | strftime("%b %-d, %Y"))</p></div></div>"
		+ (if .summary != "" then @html "<p class=\"app-summary\">\(.summary)</p>" else "" end)
		+ "<div class=\"actions\">"
		+ (if $direct then
			@html "<a class=\"btn btn-filled\" href=\"\($direct)\"><span class=\"icon icon-download\" aria-hidden=\"true\"></span>Download APK</a>"
			+ @html "<a class=\"btn btn-tonal\" href=\"obtainium://add/\($host)\($direct)\"><span class=\"icon icon-obtainium\" aria-hidden=\"true\"></span>Obtainium</a>"
			+ @html "<a class=\"btn btn-tonal\" href=\"\(.fdroid_url)\"><span class=\"icon icon-fdroid\" aria-hidden=\"true\"></span>F-Droid</a>"
		else
			@html "<a class=\"btn btn-filled\" href=\"\(.fdroid_url)\"><span class=\"icon icon-fdroid\" aria-hidden=\"true\"></span>Add to F-Droid</a>"
		end)
		+ "</div>"
		+ (if $direct then "" else "<p class=\"note\"><span class=\"icon icon-lock\" aria-hidden=\"true\"></span>Private repository. F-Droid asks for the lab login.</p>" end)
		+ "</li>";
	$template | split("<!--APPS-->") | join([$apps[] | card] | join(""))')
put "$out/index.html" <<<"$page"
