#!/usr/bin/env bash
# Regenerate types/ from the installed Claude Code. The engine writes a mod's API declarations into
# .claude-plugin/types/ beside any mod it loads from a folder the person owns, and only an interactive
# session does that, so this loads an empty mod in one, on a tmux server of its own, copies the
# declarations and exits it. No MCP server is connected, so no account's tool schemas end up here.
set -euo pipefail
out=$(cd "$(dirname "$0")/.." && pwd)/types
mod=$(mktemp -d)
sock=claude-code-types-$$
trap 'tmux -L "$sock" kill-server 2>/dev/null || true; rm -rf "$mod"' EXIT
mkdir -p "$mod/hooks"
printf '{ "description": "type generator", "modules": ["./register.ts"] }\n' >"$mod/hooks/hooks.json"
printf 'export function register() {}\n' >"$mod/hooks/register.ts"
printf '{ "mcpServers": {} }\n' >"$mod/mcp.json"
tmux -L "$sock" new-session -d -x 200 -y 50 \
	"cd '$mod' && claude --strict-mcp-config --mcp-config '$mod/mcp.json' --plugin-dir '$mod'"
written="$mod/.claude-plugin/types"
for _ in $(seq 120); do
	[ -s "$written/claude-code/index.d.ts" ] && [ -s "$written/claude-code-tools/index.d.ts" ] && [ -s "$written/claude-code-mcp/index.d.ts" ] && break
	sleep 1
done
[ -s "$written/claude-code/index.d.ts" ] || { echo "generate: Claude Code wrote no declarations in 120 s" >&2; exit 1; }
sleep 2 # let the last write finish
tmux -L "$sock" send-keys "/exit" Enter
# a connected server's tools would appear as "mcp__<server>__<tool>": keys of McpToolInputs
if grep -E -q '"mcp__[^"<>]+__[^"<>]+"[[:space:]]*:' "$written/claude-code-mcp/index.d.ts"; then
	echo "generate: an MCP server's tool inputs were written; refusing to copy them" >&2
	exit 1
fi
for t in claude-code claude-code-tools claude-code-mcp; do
	install -D -m 644 "$written/$t/index.d.ts" "$out/$t/index.d.ts"
done
head -n 1 "$out/claude-code/index.d.ts"
