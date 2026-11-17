"""Stand-ins for the voice head, the Wyoming voice server and the sleeping host's network card."""

import json
import socket
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "test-token"
MAC = "bc:fc:e7:00:11:22"


def serve(server) -> None:
    threading.Thread(target=server.serve_forever, daemon=True).start()


class FakeHead(ThreadingHTTPServer):
    """Checks the bearer token itself, records each call, and holds a turn open until released."""

    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _HeadHandler)
        self.calls: list[tuple[str, dict]] = []
        self.release_turn = threading.Event()
        self.turn_timed_out = False
        serve(self)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _HeadHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            return self._json(401, {"error": "bearer token required"})
        self.server.calls.append((self.path, body))
        if self.path == "/v1/conversations":
            return self._json(200, {"id": "0123456789ab"})
        if self.path.endswith("/turns"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'event: sentence\ndata: {"text": "First."}\n\n')
            self.wfile.flush()
            self.server.turn_timed_out = not self.server.release_turn.wait(5)
            self.wfile.write(b'event: sentence\ndata: {"text": "Second."}\n\n')
            done = {"end_conversation": body.get("text") == "goodbye", "latency_ms": {}}
            self.wfile.write(f"event: done\ndata: {json.dumps(done)}\n\n".encode())
            return None
        if self.path.endswith("/end"):
            if body.get("reason") == "x":
                return self._json(409, {"error": "conversation already ended"})
            return self._json(200, {"merged": True, "delivery": "nothing to deliver"})
        return self._json(200, {"ok": True})


class FakeVoice(socketserver.ThreadingTCPServer):
    """A Wyoming server: one audio chunk per word of the text, each word's bytes as the audio."""

    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, fail_after_first_chunk: bool = False, port: int = 0):
        super().__init__(("127.0.0.1", port), _VoiceHandler)
        self.fail_after_first_chunk = fail_after_first_chunk
        self.requests_seen: list[dict] = []
        serve(self)

    @property
    def address(self) -> str:
        return f"127.0.0.1:{self.server_address[1]}"


class _VoiceHandler(socketserver.StreamRequestHandler):
    def _event(self, kind: str, data: dict | None = None, payload: bytes = b"") -> None:
        extra = json.dumps(data or {}).encode()
        header = {"type": kind, "data_length": len(extra), "payload_length": len(payload)}
        self.wfile.write(json.dumps(header).encode() + b"\n" + extra + payload)
        self.wfile.flush()

    def handle(self):
        line = self.rfile.readline()
        if not line:
            return
        header = json.loads(line)
        request = json.loads(self.rfile.read(header["data_length"]))
        self.server.requests_seen.append(request)
        self._event("audio-start", {"rate": 24000, "width": 2, "channels": 1})
        for index, word in enumerate(request["text"].split()):
            if index == 1 and self.server.fail_after_first_chunk:
                return self._event("error", {"text": "CUDA out of memory"})
            self._event("audio-chunk", {"rate": 24000, "width": 2, "channels": 1}, word.encode())
        self._event("audio-stop")


class WakeListener:
    """Receives what would be a broadcast to the sleeping host."""

    def __init__(self):
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.settimeout(0.5)

    @property
    def address(self) -> str:
        return f"127.0.0.1:{self._sock.getsockname()[1]}"

    def packets(self) -> list[bytes]:
        found = []
        while True:
            try:
                found.append(self._sock.recv(1024))
            except TimeoutError:
                return found

    def close(self) -> None:
        self._sock.close()


def closed_port() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return f"127.0.0.1:{sock.getsockname()[1]}"
