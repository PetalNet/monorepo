import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
FAKE_CLAUDE = Path(__file__).resolve().parent / "fake_claude.py"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class FakeHub:
    def __init__(self, root: Path):
        self.state_file = root / "hub-state.json"
        self.transcript = root / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(root)) / "parent-session-id.jsonl"
        self.transcript.parent.mkdir(parents=True)
        self.transcript.write_text("")
        self.accepted: list[dict] = []
        self.drops_repeats = False
        self.max_text = 20000
        self.refuse_with: int | None = None
        self.refuse_when = None
        self.attempts = 0
        self.down = False
        self.on_accept = None
        self._persist([])
        hub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._send(503 if hub.down else 200, {"ok": True, "inject_keys": hub.drops_repeats})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                hub.attempts += 1
                if hub.down:
                    return self._send(503, {})
                if hub.refuse_with:
                    return self._send(hub.refuse_with, {"ok": False, "error": "refused"})
                if len(body.get("text", "")) > hub.max_text or (hub.refuse_when and hub.refuse_when(body.get("text", ""))):
                    return self._send(400, {"ok": False, "error": "text must be 1-20000 characters"})
                if hub.drops_repeats and any(m.get("key") == body.get("key") for m in hub.accepted):
                    return self._send(200, {"ok": True, "id": "dup", "duplicate": True})
                hub.accepted.append(body)
                hub._persist(hub.accepted)
                if hub.on_accept:
                    return hub.on_accept()
                self._send(200, {"ok": True, "id": f"m{len(hub.accepted)}"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def _persist(self, inbox: list[dict]) -> None:
        self.state_file.write_text(json.dumps({"sid": "parent-session-id", "inbox": inbox, "inflight": {}}))

    def main_consumes(self) -> None:
        with open(self.transcript, "a", encoding="utf-8") as file:
            for message in self.accepted:
                content = f'<channel source="hermes-link" sender="cron {message["source"]}" kind="cron">\n{message["text"]}\n</channel>'
                file.write(json.dumps({"type": "user", "origin": {"kind": "plugin", "name": "hermes-link"}, "message": {"role": "user", "content": content}}) + "\n")
        self._persist([])

    def texts(self, source: str) -> list[str]:
        return [m["text"] for m in self.accepted if m["source"] == source]


class HeadCase(unittest.TestCase):
    overrides: dict = {}

    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.hub = FakeHub(self.root)
        self.addCleanup(self.hub.server.shutdown)
        self.port = free_port()
        self.token_file = self.root / "token"
        self.claude_log = self.root / "claude.log"
        self.claude_extra: list[str] = []
        self.head = None
        self.addCleanup(self.stop_head)
        self.start_head()

    def start_head(self, **overrides) -> None:
        (self.root / "hub-token").write_text("hub-secret\n")
        settings = {"soft_merge": "asks", "idle_timeout_s": 120, **self.overrides, **overrides}
        claude = [sys.executable, str(FAKE_CLAUDE), "--fake-log", str(self.claude_log), *self.claude_extra]
        config = self.root / "head.toml"
        config.write_text("\n".join([
            f'listen = ["127.0.0.1:{self.port}"]',
            f'token_file = "{self.token_file}"',
            f'state_dir = "{self.root / "state"}"',
            f'main_cwd = "{self.root}"',
            f"claude = {json.dumps(claude)}",
            *(f"{key} = {json.dumps(value)}" for key, value in settings.items()),
            "[hub]",
            f'url = "{self.hub.url}"',
            f'token_file = "{self.root / "hub-token"}"',
            f'state_file = "{self.hub.state_file}"',
        ]))
        (self.root / "state").mkdir(exist_ok=True)
        env = {**os.environ, "HOME": str(self.root), "PYTHONPATH": str(APP), "HERMES_LINK_URL": "http://hub.invalid", "HERMES_LINK_TOKEN": "x"}
        with open(self.root / "head.err", "a") as errors:
            self.head = subprocess.Popen([sys.executable, "-m", "janet_voice_head.server", "--config", str(config)], env=env, stderr=errors)
        deadline = time.monotonic() + 10
        while True:
            try:
                if self.request("GET", "/health")[0] == 200:
                    break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)
        self.token = self.token_file.read_text().strip()

    def stop_head(self) -> None:
        if self.head and self.head.poll() is None:
            self.head.terminate()
            self.head.wait(timeout=10)

    def kill_head(self) -> None:
        self.head.send_signal(signal.SIGKILL)
        self.head.wait(timeout=10)

    def request(self, method: str, path: str, body: dict | None = None, token: str | None = "use"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        headers = {"content-type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + (getattr(self, "token", "") if token == "use" else token)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            raw = response.read()
        finally:
            connection.close()
        if response.headers.get("content-type") == "text/event-stream":
            return response.status, parse_sse(raw.decode())
        return response.status, json.loads(raw or b"{}")

    def open(self, tier: str | None = "personal", **extra) -> str:
        body = {"channel": "desk", **extra}
        if tier:
            body["tier"] = tier
        status, reply = self.request("POST", "/v1/conversations", body)
        self.assertEqual(status, 200, reply)
        return reply["id"]

    def turn(self, conv: str, text: str) -> tuple[list[str], dict]:
        status, events = self.request("POST", f"/v1/conversations/{conv}/turns", {"text": text})
        self.assertEqual(status, 200, events)
        return [data["text"] for name, data in events if name == "sentence"], next(data for name, data in events if name == "done")

    def end(self, conv: str, reason: str = "client"):
        return self.request("POST", f"/v1/conversations/{conv}/end", {"reason": reason})

    def prompts(self) -> list[str]:
        if not self.claude_log.exists():
            return []
        return [entry["prompt"] for line in self.claude_log.read_text().splitlines() if "prompt" in (entry := json.loads(line))]

    def launches(self) -> list[dict]:
        return [entry for line in self.claude_log.read_text().splitlines() if "argv" in (entry := json.loads(line))]

    def wait_for(self, check, message: str, timeout: float = 10):
        deadline = time.monotonic() + timeout
        while not check():
            if time.monotonic() > deadline:
                self.fail(message)
            time.sleep(0.05)


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((fields["event"], json.loads(fields["data"])))
    return events
