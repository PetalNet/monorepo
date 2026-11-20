#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prefix="$HOME/.local/share/janet-ring"
bin_dir="$HOME/.claude/bin"
defaults=()
while (($#)); do
  case "$1" in
    --prefix|--bin-dir|--ssh|--container|--config|--device)
      (($# >= 2)) || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      case "$1" in
        --prefix) prefix=$2 ;;
        --bin-dir) bin_dir=$2 ;;
        *) defaults+=("$1" "$2") ;;
      esac
      shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

install -d -m 700 "$prefix" "$bin_dir"
install -m 644 "$here"/{janet_ring,ringing,pairing}.py "$prefix/"
python_path=$(command -v python3)
"$python_path" -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"'
python3 - "$python_path" "$prefix" "$bin_dir/janet-ring" "${defaults[@]}" <<'PY'
from pathlib import Path
import shlex
import sys

python, prefix, target, *defaults = sys.argv[1:]
command = shlex.join([python, str(Path(prefix).resolve() / "janet_ring.py"), *defaults])
path = Path(target)
path.write_text('#!/bin/sh\nexec ' + command + ' "$@"\n')
path.chmod(0o700)
PY
printf 'Installed %s/janet-ring\n' "$bin_dir"
