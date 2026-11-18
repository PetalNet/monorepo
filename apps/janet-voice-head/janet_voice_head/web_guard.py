"""What a personal head may fetch. WebFetch is denied to loopback, private, link-local and tailnet targets and to the lab's names.

Claude Code's deny rules match a domain by name only: `WebFetch(domain:10.*)` matches nothing (checked against claude 2.1.326), so
private ranges are refused by a PreToolUse hook that resolves the host and checks every address. The named rules stay as a second layer.
Run as a script, this file is that hook.
"""

import ipaddress
import json
import shlex
import socket
import sys
from pathlib import Path
from urllib.parse import urlsplit

TOOLS = frozenset({"WebSearch", "WebFetch"})
DENIED_DOMAINS = ("localhost", "petalcat.dev", "*.petalcat.dev", "ts.net", "*.ts.net", "*.local", "*.internal", "*.lan")
_DENIED_SUFFIXES = tuple("." + domain.removeprefix("*.") for domain in DENIED_DOMAINS)


def settings(tools, base: dict | None = None) -> dict:
    """The --settings JSON for a head that may use `tools`, merged into `base` (a main-like fork's own settings), which is not modified.

    Claude reads only the last --settings, so a main-like fork's settings and ours have to be one document. A blanket deny of a
    tool in `tools` is dropped from the base: this is the one place that lifts it.
    """
    base = base or {}
    permissions = base.get("permissions") or {}
    allow = [*permissions.get("allow", []), *sorted(tools)]
    deny = [rule for rule in permissions.get("deny", []) if rule not in tools]
    hooks = dict(base.get("hooks") or {})
    if "WebFetch" in tools:
        deny += [f"WebFetch(domain:{domain})" for domain in DENIED_DOMAINS]
        # Claude treats any exit but 2 as a hook error and fetches anyway, so a hook that cannot start must still say 2.
        command = f"{shlex.quote(sys.executable)} -I {shlex.quote(__file__)} || exit 2"
        hooks["PreToolUse"] = [*hooks.get("PreToolUse", []), {"matcher": "WebFetch", "hooks": [{"type": "command", "command": command}]}]
    result = {**base, "permissions": {**permissions, "allow": allow, "deny": deny}}
    if hooks:
        result["hooks"] = hooks
    return result


def main_like_args(args: list[str], tools) -> list[str]:
    """`args` (a main-like fork's extra flags) with its --settings file merged with the web settings, or ours added when it has none."""
    if "--settings" not in args:
        return [*args, "--settings", json.dumps(settings(tools))]
    at = args.index("--settings") + 1
    value = args[at]
    base = json.loads(value if value.lstrip().startswith("{") else Path(value).read_text(encoding="utf-8"))
    return [*args[:at], json.dumps(settings(tools, base)), *args[at + 1:]]


def refusal(url: str, resolve=socket.getaddrinfo) -> str | None:
    """Why `url` may not be fetched, or None when it may."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").rstrip(".").lower()
        host = host.encode("idna").decode() if host and not host.isascii() else host
    except (ValueError, UnicodeError):
        return "not a valid URL"
    if parts.scheme not in ("http", "https") or not host or parts.username is not None:
        return "only plain http and https URLs are fetched"
    if "." not in host and ":" not in host or host == "localhost" or ("." + host).endswith(_DENIED_SUFFIXES):
        return f"{host} is a private name"
    try:
        # getaddrinfo also decodes the odd spellings of an address (2130706433, 0x7f.1) the way a fetcher would.
        addresses = {info[4][0].split("%")[0] for info in resolve(host, parts.port or 443, proto=socket.IPPROTO_TCP)}
    except (OSError, UnicodeError):
        return f"{host} does not resolve"
    for text in addresses:
        address = ipaddress.ip_address(text)
        if address.version == 6:
            embedded = address.ipv4_mapped or (ipaddress.IPv4Address(address.packed[-4:]) if address.packed[:12] in (bytes(12), bytes.fromhex("0064ff9b" + "00" * 8)) else None)
            address = embedded or address
        if not address.is_global or address.is_multicast:
            return f"{host} resolves to a private address"
    return None


def _hook() -> None:
    try:
        reason = refusal(str(json.load(sys.stdin)["tool_input"]["url"]))
    except Exception as error:
        reason = f"could not check the URL ({type(error).__name__})"
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": f"WebFetch refused: {reason}."}}))


if __name__ == "__main__":
    _hook()
