"""The voice head's fixed read-only lab tools, served over MCP stdio."""

import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

TIMEOUT_S = 3
MAX_OUTPUT = 12000
MAX_OBJECTIVES_INPUT = 1024 * 1024
SERVER = "janet_lab"
DESCRIPTIONS = {
    "builders": "List running lab builders and their systemd state. No builder logs or task prompts.",
    "objectives": "Read the lab's open objectives. Missing data is reported as unavailable.",
    "usage": "Read current Claude and Codex quota numbers through the router readers. Sources are provider snapshots; missing numbers are unavailable.",
    "health": "Read this host's load, memory pressure and disk space. Does not run health watchers or send alerts.",
    "pull_requests": "List open PRs in PetalNet/monorepo and PetalNet/janet-nix, with titles, draft state and URLs.",
}
NAMES = tuple(f"mcp__{SERVER}__{name}" for name in DESCRIPTIONS)

# Parse the Claude snapshot directly: the usage CLI refreshes it by writing when stale.
QUOTA_SCRIPT = """
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const source = pathToFileURL(process.argv[1]);
const { defaultSourceDeps, sourceConfigFromEnv, parseClaudeUsageJson, readCodex } = await import(source.href);
const config = sourceConfigFromEnv();
const deps = defaultSourceDeps();
let claude;
try {
    claude = parseClaudeUsageJson(readFileSync(process.env.HOME + '/.claude/shared/janet-usage.json', 'utf8'), deps.now(), config.timeZone);
} catch {
    claude = { service: 'claude', status: 'error', limits: [] };
}
const reports = [claude, await readCodex(config, deps)];
process.stdout.write(JSON.stringify(reports));
"""


def bounded_lines(lines: list[str]) -> str:
    result = []
    size = 0
    suffix = "\n… More objectives remain in the ledger; ask main Janet for details."
    for line in lines:
        size += len((line + "\n").encode("utf-8"))
        if size + len(suffix.encode("utf-8")) > MAX_OUTPUT:
            return "\n".join(result) + suffix
        result.append(line)
    return "\n".join(result)


def objective_sections(fd: int, deadline: float) -> list[str]:
    # Read the checked inode, with a separate input cap because the ledger exceeds the output cap.
    with os.fdopen(os.dup(fd), "rb") as source:
        data = source.read(MAX_OBJECTIVES_INPUT + 1)
    os.lseek(fd, 0, os.SEEK_SET)
    if len(data) > MAX_OBJECTIVES_INPUT:
        raise ValueError("Objectives source exceeds the input limit.")
    if time.monotonic() >= deadline:
        raise TimeoutError("Lab lookup timed out after three seconds.")
    sections = []
    current = None
    for line in data.decode("utf-8", "replace").splitlines():
        heading = re.match(r"^#{2,6} (.+)", line)
        if heading:
            sections.append("- " + heading[1][:240])
            current = len(sections) - 1
        elif re.match(r"^- [^*]{0,12}\*\*", line):
            current = None
        elif current is not None and re.match(r"^- (?:next(?: action)?|waiting-on):", line, re.IGNORECASE):
            sections[current] += " | " + line[2:202]
            current = None
    return list(reversed(sections))


def usage(deadline: float) -> str:
    source = Path(__file__).resolve().parents[3] / "packages/harness-hooks/src/quota-sources.ts"
    reports = json.loads(run(["node", "--no-warnings", "--input-type=module", "--eval", QUOTA_SCRIPT, str(source)], deadline))
    if not isinstance(reports, list):
        raise ValueError("Invalid quota report.")
    lines = ["Current quota lookup (provider snapshots; Codex snapshot age unavailable):"]
    for service in ("claude", "codex"):
        provider = service.title()
        report = next((r for r in reports if isinstance(r, dict) and r.get("service") == service), {})
        limits = report.get("limits", []) if report.get("status") == "ok" else []
        rows = []
        for limit in limits:
            pct = limit["usedPct"]
            label = limit["label"]
            if type(pct) not in (int, float) or not 0 <= pct <= sys.float_info.max or not math.isfinite(pct):
                raise ValueError("Invalid quota percentage.")
            if not isinstance(label, str) or not label.startswith(provider + " ") or len(label) > 80:
                raise ValueError("Invalid quota label.")
            reset = limit.get("resetLabel")
            rows.append(f"{label}: {pct:g}% used" + (f" (resets {reset[:60]})" if isinstance(reset, str) else ""))
        stale = re.search(r"\bstale \d+m\b", str(report.get("summary", "")))
        lines.extend(rows or [f"{provider}: unavailable (no current quota numbers)."])
        if rows and stale:
            lines.append(f"{provider}: {stale[0]}; ask main Janet for a refresh.")
    text = "\n".join(lines)
    if len(text.encode("utf-8")) > MAX_OUTPUT:
        raise ValueError("Quota result exceeded the voice output limit.")
    return text


def mcp_config() -> dict:
    return {"mcpServers": {SERVER: {"command": sys.executable, "args": ["-I", str(Path(__file__).resolve())]}}}


def run(argv: list[str], deadline: float, *, source_fd: int | None = None) -> str:
    """Bound both pipe consumption and the whole process group, including children."""
    env = {key: value for key, value in os.environ.items() if key in (
        "HOME", "PATH", "USER", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE")}
    env.update(GH_PROMPT_DISABLED="1", GH_PAGER="cat", SYSTEMD_PAGER="cat", SYSTEMD_COLORS="0")
    if source_fd is not None:
        env["OBJECTIVES_LEDGER"] = "/dev/stdin"
    proc = subprocess.Popen(argv, stdin=source_fd if source_fd is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
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
        command = Path.home() / ".local/state/objectives-index-pkg/bin/sessionstart-objectives"
        fd = os.open(Path.home() / ".claude/shared/open-objectives.md", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("Objectives source must be a regular file.")
            sections = objective_sections(fd, deadline)
            # The index reads this open inode, even if the pathname is replaced while it runs.
            context = json.loads(run([str(command)], deadline, source_fd=fd))["hookSpecificOutput"]["additionalContext"]
        finally:
            os.close(fd)
        entries = [line for line in context.splitlines() if line.startswith("- ")]
        lines = (["Current objective sections (newest first):", *sections] if sections else [])
        if entries:
            lines.extend(["Recent open objectives (bounded index):", *entries])
        return bounded_lines(lines) if lines else "No indexed objectives available."
    if name == "usage":
        return usage(deadline)
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
            if len(text.encode("utf-8")) > MAX_OUTPUT:
                raise ValueError("Lab result exceeded the voice output limit.")
            result = {"content": [{"type": "text", "text": text}], "isError": False}
        except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
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
