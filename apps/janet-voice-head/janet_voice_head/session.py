import json
import os
import queue
import re
import subprocess
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from . import web_guard, lab_tools, call_tools

# Main's hermes-link plugin re-points the hub at whichever session loads it, so a head must load nothing of main's.
def locked_flags(web_tools: tuple[str, ...] = (), lab: bool = False, lab_config: dict | None = None) -> list[str]:
    """Base tool boundary; ClaudeSession adds its own call-control MCP server."""
    flags = [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--include-partial-messages", "--tools", ",".join(web_tools), "--strict-mcp-config",
        "--mcp-config", json.dumps(lab_config or lab_tools.mcp_config(), separators=(",", ":")) if lab else '{"mcpServers":{}}', "--setting-sources", "",
    ]
    if web_tools or lab:
        allowed = (*web_tools, *(lab_tools.NAMES if lab else ()))
        settings = web_guard.settings(web_tools)
        settings["permissions"]["allow"] = sorted(allowed)
        flags += ["--settings", json.dumps(settings), "--permission-mode", "dontAsk"]
    return flags


ENV_ALLOW = (
    "HOME", "PATH", "USER", "LANG", "LC_ALL", "TZ", "NIX_LD", "NIX_LD_LIBRARY_PATH",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE",
)


class SessionError(Exception):
    pass


@dataclass(frozen=True)
class UnspokenText:
    """Text after call control still carries relays, but does not supply speech."""
    text: str


def transcript_path(cwd: str, session_id: str) -> Path:
    return Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", cwd) / f"{session_id}.jsonl"


def session_env(environ=os.environ) -> dict[str, str]:
    return {key: environ[key] for key in ENV_ALLOW if key in environ}


class ClaudeSession:
    def __init__(self, argv: list[str], cwd: str, env: dict[str, str] | None = None, allow_tools: bool = False,
                 web_tools: tuple[str, ...] = (), lab: bool = False):
        self.timing_observer = None
        self.session_id: str | None = None
        self.account_email: str | None = None
        self.failure: str | None = None
        self._verified = False
        self._allow_tools = allow_tools
        self._web_tools = frozenset((*web_tools, *(lab_tools.NAMES if lab else ()), *call_tools.NAMES))
        self._lab = lab
        self._initialized = False
        self._ready = threading.Event()
        self._events: queue.Queue = queue.Queue()
        self._active = False
        self._answering = False
        self._call_tool_started = False
        self._write_lock = threading.Lock()
        argv = web_guard.main_like_args(list(argv), call_tools.NAMES)
        if "--permission-mode" not in argv:
            argv += ["--permission-mode", "dontAsk"]
        servers = {}
        if "--mcp-config" in argv:
            at = argv.index("--mcp-config") + 1
            value = argv[at]
            servers = json.loads(value if value.lstrip().startswith("{") else Path(value).read_text())["mcpServers"]
        self.call_control = call_tools.CallControl()
        if "--mcp-config" in argv:
            argv[at] = json.dumps({"mcpServers": {**servers, **self.call_control.mcp_config()}})
        else:
            argv += ["--mcp-config", json.dumps({"mcpServers": self.call_control.mcp_config()})]
        try:
            self._proc = subprocess.Popen(argv, cwd=cwd, env=env if env is not None else session_env(), stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        except OSError:
            self.call_control.close()
            raise
        threading.Thread(target=self._read, daemon=True).start()
        self._send({"type": "control_request", "request_id": "init", "request": {"subtype": "initialize"}})

    def wait_ready(self, timeout: float) -> None:
        if not self._ready.wait(timeout):
            self._fail("the session did not become ready")
        if self.failure:
            raise SessionError(self.failure)

    def turn(self, text: str, timeout: float) -> Iterator[str | UnspokenText]:
        if self.failure:
            raise SessionError(self.failure)
        self._answering, self._active = False, True
        self._call_tool_started = False
        deadline = time.monotonic() + timeout
        first_token = False
        seen_usage = set()
        usage = {}
        usage_keys = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
        try:
            if self.timing_observer:
                self.timing_observer("model_request", {})
            self._send({"type": "user", "message": {"role": "user", "content": text}})
            while True:
                try:
                    kind, value = self._events.get(timeout=max(0.0, deadline - time.monotonic()))
                except queue.Empty:
                    self._fail("the turn timed out")
                    raise SessionError(self.failure) from None
                if kind == "observation":
                    event, fields, stamp, at = value
                    if event == "model_first_token":
                        if first_token:
                            continue
                        first_token = True
                    elif event == "model_usage":
                        counts = {key: fields[key] for key in usage_keys
                                  if isinstance(fields.get(key), int) and not isinstance(fields[key], bool) and fields[key] >= 0}
                        if fields.get("source") == "result":
                            usage = counts
                        else:
                            message_id = fields.get("message_id")
                            if not message_id or message_id in seen_usage:
                                continue
                            seen_usage.add(message_id)
                            counts.pop("output_tokens", None)
                            for key, count in counts.items():
                                usage[key] = usage.get(key, 0) + count
                        fields = {"usage": dict(usage), "source": fields["source"]}
                    if self.timing_observer:
                        self.timing_observer(event, fields, stamp, at)
                elif kind == "delta":
                    yield value
                elif kind == "unspoken":
                    yield UnspokenText(value)
                elif kind == "end":
                    return
                else:
                    raise SessionError(value)
        finally:
            self._active = False

    def interrupt(self) -> None:
        if self._active and not self.failure:
            self._send({"type": "control_request", "request_id": "interrupt", "request": {"subtype": "interrupt"}})

    def close(self) -> None:
        self.failure = self.failure or "closed"
        try:
            self._proc.stdin.close()
            self._proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self._proc.kill()
        self.call_control.close()

    def _send(self, message: dict) -> None:
        try:
            with self._write_lock:
                self._proc.stdin.write(json.dumps(message) + "\n")
                self._proc.stdin.flush()
        except (OSError, ValueError):
            self._fail("the session process is gone")

    def _fail(self, reason: str) -> None:
        if not self.failure:
            self.failure = reason
            self._proc.kill()
        self._ready.set()
        self._events.put(("dead", self.failure))

    def _read(self) -> None:
        for line in self._proc.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            self._on_event(event)
        self._fail("the session process exited")

    def _on_event(self, event: dict) -> None:
        kind = event.get("type")

        def observation(name, fields):
            self._events.put(("observation", (name, fields, time.monotonic(), time.time())))

        if self._active and kind == "assistant" and not event.get("parent_tool_use_id"):
            message = event.get("message") or {}
            observation("model_usage", {**(message.get("usage") or {}), "source": "assistant", "message_id": message.get("id")})
        if kind == "control_response":
            response = (event.get("response") or {}).get("response") or {}
            if "account" in response:
                self.account_email = (response.get("account") or {}).get("email")
                self._initialized = True
        elif kind == "system" and event.get("subtype") == "init":
            servers = {call_tools.SERVER, *([lab_tools.SERVER] if self._lab else [])}
            if not self._allow_tools and (any(server.get("name") not in servers for server in (event.get("mcp_servers") or ())) or not self._web_tools.issuperset(event.get("tools") or ())):
                return self._fail("the session came up with tools or MCP servers")
            self.session_id, self._verified = event.get("session_id"), True
        elif kind == "system" and event.get("subtype") == "status" and event.get("status") == "requesting":
            self._answering = True
        elif kind == "stream_event":
            if not self._verified:
                return self._fail("the session answered before it reported its tools")
            self._answering = True
            inner = event.get("event") or {}
            delta = inner.get("delta") or {}
            if inner.get("type") == "content_block_start" and (inner.get("content_block") or {}).get("type") == "tool_use" and self._active:
                unspoken = self._call_tool_started and self.call_control.closing_queued
                if (inner.get("content_block") or {}).get("name") in call_tools.NAMES:
                    self._call_tool_started = True
                # A lookup begins: end the sentence before it ("one sec, checking.") so it is spoken while the tool runs.
                self._events.put(("unspoken" if unspoken else "delta", "\n"))
            if inner.get("type") == "content_block_delta" and delta.get("type") == "text_delta" and self._active:
                if delta.get("text"):
                    observation("model_first_token", {})
                unspoken = self._call_tool_started and self.call_control.closing_queued
                self._events.put(("unspoken" if unspoken else "delta", delta.get("text", "")))
        elif kind == "result":
            # A resumed session reports one result for the resume itself, before any turn.
            aborted = str(event.get("terminal_reason", "")).startswith("aborted")
            if self._active and (self._answering or aborted or event.get("is_error")):
                if isinstance(event.get("usage"), dict):
                    observation("model_usage", {**event["usage"], "source": "result"})
                self._events.put(("end", None))
        # Ready means the process answers. When it lists its tools varies: a fork used to at
        # resume and now, like a fresh session, does on its first turn. Either way no text is
        # passed on before the list has been checked against the allowed tools (the stream_event check above).
        if self._initialized and not self._ready.is_set():
            self._ready.set()
