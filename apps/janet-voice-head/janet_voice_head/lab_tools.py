"""The voice head's fixed read-only lab tools, served over MCP stdio."""

import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

TIMEOUT_S = 3
MAX_OUTPUT = 12000
SERVER = "janet_lab"
DESCRIPTIONS = {
    "builders": "List running lab builders and their systemd state. No builder logs or task prompts.",
    "objectives": "Read the lab's open objectives. Missing data is reported as unavailable.",
    "health": "Read this host's load, memory pressure and disk space. Does not run health watchers or send alerts.",
    "pull_requests": "List open PRs in PetalNet/monorepo and PetalNet/janet-nix, with titles, draft state and URLs.",
}
NAMES = tuple(f"mcp__{SERVER}__{name}" for name in DESCRIPTIONS)


def mcp_config() -> dict:
    return {"mcpServers": {SERVER: {"command": sys.executable, "args": ["-I", str(Path(__file__).resolve())]}}}


def run(argv: list[str], deadline: float) -> str:
    """Bound both pipe consumption and the whole process group, including children."""
    env = {key: value for key, value in os.environ.items() if key in (
        "HOME", "PATH", "USER", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE")}
    env.update(GH_PROMPT_DISABLED="1", GH_PAGER="cat", SYSTEMD_PAGER="cat", SYSTEMD_COLORS="0")
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    output = bytearray()
    try:
        with selectors.DefaultSelector() as poll:
            poll.register(proc.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not poll.select(remaining):
                    raise TimeoutError("Lab lookup timed out after three seconds.")
                chunk = os.read(proc.stdout.fileno(), min(4096, MAX_OUTPUT + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > MAX_OUTPUT:
                    raise ValueError("Lab result exceeded the voice output limit; ask main Janet for details.")
        if proc.wait(timeout=max(0.001, deadline - time.monotonic())):
            raise ValueError("Lab source unavailable; no current result.")
        return output.decode("utf-8", "replace").strip()
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        proc.stdout.close()


def lookup(name: str, arguments: dict) -> str:
    if name not in DESCRIPTIONS or arguments != {}:
        raise ValueError("Only the listed lab tools with empty arguments are allowed.")
    deadline = time.monotonic() + TIMEOUT_S
    if name == "builders":
        units = json.loads(run(["systemctl", "--user", "list-units", "route-*", "--state=running,activating", "--no-pager", "--output=json"], deadline))
        return "\n".join(f"{unit['unit']}: {unit['active']} {unit['sub']}" for unit in units) or "No builders are running."
    if name == "objectives":
        path = Path.home() / ".claude/shared/open-objectives.md"
        # O_NOFOLLOW prevents replacing an allowed source with a link to credentials.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            data = source.read(MAX_OUTPUT + 1)
        if len(data) > MAX_OUTPUT:
            raise ValueError("Objectives exceed the voice output limit; ask main Janet for details.")
        return data.decode("utf-8", "replace")
    if name == "health":
        return run(["uptime"], deadline) + "\n" + run(["free", "-m"], deadline) + "\n" + run(["df", "-h", "/"], deadline)
    return "\n".join(repo + ": " + run([
        "gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", "10", "--json", "number,title,isDraft,url",
    ], deadline) for repo in ("PetalNet/monorepo", "PetalNet/janet-nix"))


def respond(request: dict) -> dict | None:
    if "id" not in request:
        return None
    result = {}
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": SERVER, "version": "1.0"}}
    elif method == "tools/list":
        result = {"tools": [{"name": name, "description": description, "inputSchema": {
            "type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        } for name, description in DESCRIPTIONS.items()]}
    elif method == "tools/call":
        params = request.get("params") or {}
        try:
            text = lookup(params.get("name"), params.get("arguments", {}))
            result = {"content": [{"type": "text", "text": text}], "isError": False}
        except (OSError, ValueError, TimeoutError, subprocess.SubprocessError):
            result = {"content": [{"type": "text", "text": "Lab lookup unavailable or refused. Ask main Janet for details."}], "isError": True}
    elif method != "ping":
        return {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": request["id"], "result": result}


def main() -> None:
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
            response = respond(request)
            if response is not None:
                print(json.dumps(response), flush=True)
        except (ValueError, TypeError, AttributeError):
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid request"}}), flush=True)


if __name__ == "__main__":
    main()
