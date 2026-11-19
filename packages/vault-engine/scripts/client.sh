#!/usr/bin/env bash
# The vault from a host that does not hold it. Every command runs over ssh on the host that does.
# After a command that writes, the claim index is copied here, so local readers such as a
# per-prompt recall hook never need the network.
#
# Usage: client.sh <vault command> [args...]   or   client.sh pull-index   or   client.sh tunnel [port]
# The env file ($VAULT_ENV, default ~/.config/vault/env) sets:
#   VAULT_HOST     ssh host that holds the vault
#   VAULT_REMOTE   path of vault.sh on that host
#   VAULT_REPLICA  local directory for the index copy (default ~/.local/share/vault)
#   VAULT_AGENT    the writing agent's name (default: the local user)
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
set -a
# shellcheck disable=SC1090
. "${VAULT_ENV:-$HOME/.config/vault/env}"
set +a
replica=${VAULT_REPLICA:-$HOME/.local/share/vault}
# The writing agent is named here and carried across, so the op log records who asked.
remote() { "$SCRIPT_DIR/remote.sh" "$VAULT_HOST" env "VAULT_AGENT=${VAULT_AGENT:-$(id -un)}" "$VAULT_REMOTE" "$@"; }

# The index on the vault host is replaced with one rename, so a plain read is a whole index.
pull() {
	local tmp
	mkdir -p "$replica"
	# A partial copy can outlive its pull (SIGKILL, or a second signal during the trap below), so
	# old ones are swept here. The age keeps a pull that is running now out of it.
	find "$replica" -maxdepth 1 -type f -name 'index.sqlite.??????' -mmin +60 -delete 2>/dev/null || true
	tmp=$(mktemp "$replica/index.sqlite.XXXXXX")
	# A pull that is killed part way removes its partial copy. The path is expanded now, because
	# tmp is local and is out of scope when the trap runs.
	# shellcheck disable=SC2064
	trap "rm -f $(printf '%q' "$tmp")" EXIT
	if remote index >"$tmp" && [ -s "$tmp" ]; then
		mv "$tmp" "$replica/index.sqlite"
		trap - EXIT
	else
		rm -f "$tmp"
		trap - EXIT
		echo "vault: index copy failed; the local replica is stale" >&2
		return 1
	fi
}

case "${1:-}" in
pull-index)
	pull
	exit
	;;
tunnel)
	# Forwards the vault host's MCP port (`vault.sh serve`) here. Writes made over MCP do not pass
	# through this script, so the index copy is refreshed on a timer while the tunnel is up.
	port=${2:-7411}
	(while sleep 120; do pull || true; done) &
	refresher=$!
	trap 'kill "$refresher" 2>/dev/null' EXIT
	ssh -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -N -L "127.0.0.1:$port:127.0.0.1:$port" "$VAULT_HOST"
	exit
	;;
research-run)
	# The run file lives on this host; send it as stdin.
	if [ -n "${2:-}" ]; then
		remote research-run <"$2" || exit
		pull || true
		exit
	fi
	;;
esac

status=0
remote "$@" || status=$?
case "${1:-}" in
remember | research-run | source | claim | reindex) pull || true ;;
esac
exit "$status"
