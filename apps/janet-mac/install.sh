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
# The values are written into `security -i` and curl config lines, so anything outside the
# characters such tokens are made of is refused instead of being quoted.
for value in "$cf_id" "$cf_secret" "$head_token"; do
  case "$value" in
    "" | *[!A-Za-z0-9._~+/=-]*)
      echo "expected three lines of token characters (letters, digits, . _ ~ + / = -) on standard input" >&2
      exit 1
      ;;
  esac
done
case "$url" in
  https://*[!A-Za-z0-9.:/_-]* | http://*[!A-Za-z0-9.:/_-]*) echo "unexpected character in the URL" >&2; exit 1 ;;
  https://* | http://127.0.0.1:* | http://localhost:*) ;;
  *) echo "the gateway URL must be https" >&2; exit 1 ;;
esac

mkdir -p "$HOME/.local/bin" "$HOME/.config/janet-talk"
install -m 755 "$here/janet-talk" "$HOME/.local/bin/janet-talk"
printf 'JANET_VOICE_URL="%s"\n' "${url%/}" >"$HOME/.config/janet-talk/config"

# `security -i` reads commands from standard input, which keeps the secrets off the command line.
store() {
  printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$service" "$1" "$2" | security -i >/dev/null
  # `security -i` reports success even when the command inside it failed, so read the item back.
  [ "$(security find-generic-password -s "$service" -a "$1" -w 2>/dev/null)" = "$2" ] || {
    echo "could not store $1 in the Keychain (is the login keychain unlocked?)" >&2
    exit 1
  }
}
store cf-access-client-id "$cf_id"
store cf-access-client-secret "$cf_secret"
store head-token "$head_token"

# Pausing the Mac's media while Janet speaks needs the MediaRemote adapter, which is built here
# from a pinned commit. Without git, cmake and Xcode's tools, janet-talk simply pauses nothing.
adapter="$HOME/.local/share/janet-talk/mediaremote-adapter"
adapter_commit=e3ff5021eb0875858bd05f48d2e9ba2e962d1cf6 # v0.7.7
if [ "$(uname)" = Darwin ] && [ ! -e "$adapter/build/MediaRemoteAdapter.framework" ]; then
  if command -v git >/dev/null && command -v cmake >/dev/null; then
    rm -rf "$adapter"
    git clone -q https://github.com/ungive/mediaremote-adapter.git "$adapter" &&
      git -C "$adapter" checkout -q "$adapter_commit" &&
      mkdir "$adapter/build" && (cd "$adapter/build" && cmake .. >/dev/null && cmake --build . >/dev/null) ||
      echo "could not build the media adapter; Janet will not pause your media" >&2
  else
    echo "git and cmake are needed to pause media while Janet speaks; skipped" >&2
  fi
fi

config="$HOME/.config/karabiner/karabiner.json"
if [ -f "$config" ]; then
  # Keep the first backup: a second run must not replace it with a config that already has the rule.
  [ -e "$config.before-janet-talk" ] || cp "$config" "$config.before-janet-talk"
  rule=$(jq '.rules[0]' "$here/karabiner/janet-talk.json")
  jq --argjson rule "$rule" '
    (.profiles[] | select(.selected) | .complex_modifications.rules) |=
      ([$rule] + ((. // []) | map(select(.description != $rule.description))))
  ' "$config" >"$config.tmp"
  mv "$config.tmp" "$config"
  echo "Karabiner rule installed (previous config: $config.before-janet-talk)"
else
  echo "Karabiner-Elements has no config yet: open it once, then run this again." >&2
fi
# The speech model that hears when a turn has ended, and a Python environment to run it in. It
# runs on this Mac. A download that does not match its checksum stops the install. Until this
# step has worked, janet-talk judges the microphone level instead. Only on a Mac, where
# janet-talk runs.
if [ "$(uname)" = Darwin ]; then
  turn_end="$HOME/.local/share/janet-talk"
  mkdir -p "$turn_end/models"
  rm -f "$turn_end/models/smart-turn-v3.2-cpu.onnx" # an earlier version used it
  install -m 644 "$here/turn_end.py" "$turn_end/turn_end.py"
  install -m 644 "$here/turn_judge.py" "$here/turn_judge.json" "$turn_end/"
  model() { # file, sha256, url
    [ "$(shasum -a 256 "$turn_end/models/$1" 2>/dev/null | cut -d' ' -f1)" = "$2" ] && return 0
    curl -fsSL --max-time 900 -o "$turn_end/models/$1.part" "$3"
    [ "$(shasum -a 256 "$turn_end/models/$1.part" | cut -d' ' -f1)" = "$2" ] || {
      echo "$1 does not match its checksum" >&2
      exit 1
    }
    mv "$turn_end/models/$1.part" "$turn_end/models/$1"
  }
  model silero_vad.onnx 1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3 \
    https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx
  # The turn judge's speech model (194 MB, NVIDIA Open Model License). Without it a turn ends on
  # silence alone.
  parakeet=https://huggingface.co/imbcmdth/parakeet-realtime-eou-120m-onnx/resolve/974110555ac70906cbb1fe9f758cecde790d8645
  model parakeet_vocab.txt 8fe6871fa1df0813fee690d5e5ba8dfd7a66f028b12fce32ab7d51a1d1704e6f "$parakeet/vocab.txt"
  model parakeet_realtime_eou_120m.int8.onnx 7dbdf3e4f539a78819c71d1fc8c0aaf0be8d34417661a16e643cd47e17c319fd \
    "$parakeet/parakeet_realtime_eou_120m.int8.onnx"
  [ -x "$turn_end/venv/bin/python" ] || python3 -m venv "$turn_end/venv"
  "$turn_end/venv/bin/python" -c 'import numpy, onnxruntime' 2>/dev/null ||
    "$turn_end/venv/bin/python" -m pip install --quiet --disable-pip-version-check numpy==2.0.2 onnxruntime==1.19.2
fi
echo "janet-talk installed"
