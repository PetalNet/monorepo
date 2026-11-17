#!/bin/bash
# Installs janet-talk for the current user: the script, its config, three Keychain items and
# the Karabiner rule. Safe to run again.
#
#   ./install.sh https://voice.example.com < secrets
#
# Standard input is three lines: the Cloudflare Access client id, its client secret, and the
# voice head's bearer token. They go to the login Keychain and nowhere else.
set -eu

url="${1:?usage: install.sh <gateway url> < three secret lines}"
here=$(cd "$(dirname "$0")" && pwd)
service="janet-voice"

IFS= read -r cf_id
IFS= read -r cf_secret
IFS= read -r head_token
[ -n "$cf_id" ] && [ -n "$cf_secret" ] && [ -n "$head_token" ] || {
  echo "expected three non-empty lines on standard input" >&2
  exit 1
}

mkdir -p "$HOME/.local/bin" "$HOME/.config/janet-talk"
install -m 755 "$here/janet-talk" "$HOME/.local/bin/janet-talk"
printf 'JANET_VOICE_URL="%s"\n' "${url%/}" >"$HOME/.config/janet-talk/config"

# `security -i` reads commands from standard input, which keeps the secrets off the command line.
store() { printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$service" "$1" "$2" | security -i >/dev/null; }
store cf-access-client-id "$cf_id"
store cf-access-client-secret "$cf_secret"
store head-token "$head_token"

config="$HOME/.config/karabiner/karabiner.json"
if [ -f "$config" ]; then
  cp "$config" "$config.before-janet-talk"
  rule=$(jq '.rules[0]' "$here/karabiner/janet-talk.json")
  jq --argjson rule "$rule" '
    (.profiles[] | select(.selected) | .complex_modifications.rules) |=
      ([$rule] + ((. // []) | map(select(.description != $rule.description))))
  ' "$config.before-janet-talk" >"$config.tmp"
  mv "$config.tmp" "$config"
  echo "Karabiner rule installed (previous config: $config.before-janet-talk)"
else
  echo "Karabiner-Elements has no config yet: open it once, then run this again." >&2
fi
echo "janet-talk installed"
