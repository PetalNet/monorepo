"""A loopback proxy that makes a headless fork's request match main's prompt cache.

Claude Code in `-p` mode words a few tool definitions differently from the interactive session main runs
(for example the cap in Monitor's description and a sentence in DesignSync's). The model's prompt cache
matches bytes from the start of the request, so the first difference makes the fork rebuild all of main's
history after it: measured on a 90k-token fork, 14k tokens read and 76k written, against 96k read and 6k
written once the definitions agree. This copies each shared tool's definition from main's own last logged
request. It adds no tool, removes no tool, does not reorder and touches nothing but `tools`. Anything that
does not look as expected goes through unchanged, and a note says why.
"""

import http.client
import json
import logging
import threading
import time
from collections import deque
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

log = logging.getLogger("janet-voice-head")
UPSTREAM = "https://api.anthropic.com"
REFERENCE_TTL_S = 30
SHAPE_MARKER = b'"type":"api-request-shape"'
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
              "transfer-encoding", "upgrade", "host", "content-length"}


def last_shape(transcript: Path, max_bytes: int = 24 * 1024 * 1024) -> dict | None:
    """The `shape` ({system, tools}) of the last request main logged in its transcript, or None."""
    size = transcript.stat().st_size
    with transcript.open("rb") as file:
        file.seek(max(0, size - max_bytes))
        data = file.read()
    at = data.rfind(SHAPE_MARKER)
    while at != -1:
        start, end = data.rfind(b"\n", 0, at) + 1, data.find(b"\n", at)
        try:
            shape = json.loads(data[start:end if end != -1 else len(data)]).get("shape")
        except ValueError:
            shape = None
        if isinstance(shape, dict) and isinstance(shape.get("tools"), list):
            return shape
        at = data.rfind(SHAPE_MARKER, 0, at)
    return None


def normalize(body: dict, reference: dict) -> tuple[dict, str]:
    """Returns the body with each tool the fork shares with main written as main wrote it, and a note.
    No tool is added, removed or reordered. A tool whose set of keys differs from main's, after dropping
    the keys the fork does not send, is left as the fork wrote it."""
    tools, ours = body.get("tools"), reference.get("tools")
    if not isinstance(tools, list) or not isinstance(ours, list) or not tools:
        return body, "skipped: no tool list"
    if not all(isinstance(tool, dict) and isinstance(tool.get("name"), str) for tool in tools + ours):
        return body, "skipped: unexpected tool shape"
    theirs = {tool["name"]: tool for tool in ours}
    rewritten, changed = [], 0
    for tool in tools:
        main_tool = theirs.get(tool["name"])
        copy = {key: main_tool[key] for key in main_tool if key in tool} if main_tool else None
        if copy is not None and set(copy) == set(tool) and copy != tool:
            rewritten.append(copy)
            changed += 1
        else:
            rewritten.append(tool)
    if not changed:
        return body, "normalized: nothing to change"
    return {**body, "tools": rewritten}, f"normalized: {changed} tool definitions"


class Proxy(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, transcript: Callable[[], Path | None], upstream: str = UPSTREAM, capture: bool = False):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.transcript, self.upstream, self.capture = transcript, upstream, capture
        self.notes: deque[str] = deque(maxlen=50)
        self.captured: list[bytes] = []  # the requests as the fork sent them, kept only when asked, for tests and diagnosis
        self._cached: tuple[float, Path, dict | None] | None = None

    def reference(self) -> dict | None:
        """Main's last logged request shape, read at most every REFERENCE_TTL_S seconds."""
        path = self.transcript()
        if path is None:
            return None
        now = time.monotonic()
        if self._cached and self._cached[1] == path and now - self._cached[0] < REFERENCE_TTL_S:
            return self._cached[2]
        try:
            shape = last_shape(path)
        except OSError as error:
            log.warning("cache-normalize skipped: cannot read main's transcript: %s", error)
            shape = None
        self._cached = (now, path, shape)
        return shape

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        self._forward()

    def do_GET(self):
        self._forward()

    def _forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.command == "POST" and urlsplit(self.path).path == "/v1/messages":
            if self.server.capture:
                self.server.captured = [*self.server.captured[-3:], body]
            body = self._normalized(body)
        url = urlsplit(self.server.upstream)
        connect = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        upstream = connect(url.hostname, url.port, timeout=300)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        try:
            upstream.request(self.command, self.path, body=body or None, headers=headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP_BY_HOP:
                    self.send_header(key, value)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while chunk := response.read1(8192):
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (OSError, http.client.HTTPException) as error:
            log.warning("cache-normalize proxy: %s", error)
            self.close_connection = True
        finally:
            upstream.close()

    def _normalized(self, raw: bytes) -> bytes:
        try:
            body = json.loads(raw)
            reference = self.server.reference()
            if not isinstance(body, dict) or reference is None:
                self._note("skipped: no reference or not a JSON object")
                return raw
            result, note = normalize(body, reference)
            self._note(note)
            return raw if result is body else json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode()
        except (ValueError, TypeError, KeyError) as error:
            self._note(f"skipped: {error}")
            return raw

    def _note(self, note: str) -> None:
        self.server.notes.append(note)
        if note.startswith("skipped"):
            log.warning("cache-normalize %s", note)


def serve_in_background(transcript: Callable[[], Path | None], upstream: str = UPSTREAM, capture: bool = False) -> Proxy:
    proxy = Proxy(transcript, upstream, capture)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    return proxy
