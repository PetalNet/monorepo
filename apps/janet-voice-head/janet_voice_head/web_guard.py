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
from urllib.parse import urlsplit

TOOLS = frozenset({"WebSearch", "WebFetch"})
DENIED_DOMAINS = ("localhost", "petalcat.dev", "*.petalcat.dev", "ts.net", "*.ts.net", "*.local", "*.internal", "*.lan")
_DENIED_SUFFIXES = tuple("." + domain.removeprefix("*.") for domain in DENIED_DOMAINS)


def settings(tools) -> dict:
    """The --settings JSON for a head that may use `tools`."""
    allow = sorted(tools)
    deny = [f"WebFetch(domain:{domain})" for domain in DENIED_DOMAINS] if "WebFetch" in tools else []
    result: dict = {"permissions": {"allow": allow, "deny": deny}}
    if "WebFetch" in tools:
        command = f"{shlex.quote(sys.executable)} -I {shlex.quote(__file__)}"
        result["hooks"] = {"PreToolUse": [{"matcher": "WebFetch", "hooks": [{"type": "command", "command": command}]}]}
    return result


def refusal(url: str, resolve=socket.getaddrinfo) -> str | None:
    """Why `url` may not be fetched, or None when it may."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").rstrip(".").lower()
    except ValueError:
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
        address = getattr(address, "ipv4_mapped", None) or address
        if not address.is_global:
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
