import json
import os
import queue
import re
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path

# Main's hermes-link plugin re-points the hub at whichever session loads it, so a head must load nothing of main's.
LOCKED_FLAGS = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--tools", "", "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
]
ENV_ALLOW = (
    "HOME", "PATH", "USER", "LANG", "LC_ALL", "TZ", "NIX_LD", "NIX_LD_LIBRARY_PATH",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE",
)


class SessionError(Exception):
    pass


def transcript_path(cwd: str, session_id: str) -> Path:
    return Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", cwd) / f"{session_id}.jsonl"


def session_env(environ=os.environ) -> dict[str, str]:
    return {key: environ[key] for key in ENV_ALLOW if key in environ}


class ClaudeSession:
    def __init__(self, argv: list[str], cwd: str, resumed: bool):
        self.session_id: str | None = None
        self.account_email: str | None = None
        self.failure: str | None = None
        self._resumed = resumed
        self._verified = False
        self._initialized = False
        self._ready = threading.Event()
        self._events: queue.Queue = queue.Queue()
        self._active = False
        self._answering = False
        self._write_lock = threading.Lock()
        self._proc = subprocess.Popen(argv, cwd=cwd, env=session_env(), stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        threading.Thread(target=self._read, daemon=True).start()
        self._send({"type": "control_request", "request_id": "init", "request": {"subtype": "initialize"}})

    def wait_ready(self, timeout: float) -> None:
        if not self._ready.wait(timeout):
            self._fail("the session did not become ready")
        if self.failure:
            raise SessionError(self.failure)

    def turn(self, text: str, timeout: float) -> Iterator[str]:
        if self.failure:
            raise SessionError(self.failure)
        self._answering, self._active = False, True
        deadline = time.monotonic() + timeout
        try:
            self._send({"type": "user", "message": {"role": "user", "content": text}})
            while True:
                try:
                    kind, value = self._events.get(timeout=max(0.0, deadline - time.monotonic()))
                except queue.Empty:
                    self._fail("the turn timed out")
                    raise SessionError(self.failure) from None
                if kind == "delta":
                    yield value
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
        if kind == "control_response":
            response = (event.get("response") or {}).get("response") or {}
            if "account" in response:
                self.account_email = (response.get("account") or {}).get("email")
                self._initialized = True
        elif kind == "system" and event.get("subtype") == "init":
            if event.get("tools") or event.get("mcp_servers"):
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
            if inner.get("type") == "content_block_delta" and delta.get("type") == "text_delta" and self._active:
                self._events.put(("delta", delta.get("text", "")))
        elif kind == "result":
            # A resumed session reports one result for the resume itself, before any turn.
            aborted = str(event.get("terminal_reason", "")).startswith("aborted")
            if self._active and (self._answering or aborted or event.get("is_error")):
                self._events.put(("end", None))
        # A fork lists its tools when it resumes; a fresh session only on its first turn.
        if self._initialized and (self._verified or not self._resumed) and not self._ready.is_set():
            self._ready.set()
