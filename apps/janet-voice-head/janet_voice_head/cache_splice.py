"""A loopback proxy that gives a headless fork main's exact prompt prefix, so its first call reads main's cache.

The model's prompt cache matches bytes from the start of a request. A fork resumed from main's transcript holds
main's conversation, but Claude Code words parts of it differently: a few tool definitions read differently in
headless mode, and some old messages are rendered from session state main has and the fork does not (a harness
tag line in an attachment, for example). The first byte that differs makes the fork rebuild everything after it:
on a 150k-token fork, 14k tokens read and 145k written instead of nearly all read.

Main logs every request it makes in its own transcript. This takes main's latest one as the canonical prefix:
its tools, its system blocks and its messages. When a fork's request arrives, its first k messages are compared
with main's after stripping harness-tag lines, and where they correspond they are replaced by main's own, with the
fork's tail left as it is. Where they stop corresponding the splice stops, and with nothing in common, or with any
doubt (main's request older than the cache lifetime, another session, a tool_use without its tool_result), the
request goes through unchanged and a "splice skipped" line says why.
"""

import hashlib
import http.client
import json
import logging
import re
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .snapshot import last_boundary_offset

log = logging.getLogger("janet-voice-head")
UPSTREAM = "https://api.anthropic.com"
REFERENCE_TTL_S = 20
CACHE_LIFETIME_S = 3600 - 120
SCAN_FALLBACK_BYTES = 16 * 1024 * 1024
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
              "transfer-encoding", "upgrade", "host", "content-length"}
REPLY_ONLY = {"server", "date"}  # the proxy sends its own
BILLING = "x-anthropic-billing-header:"
HARNESS_TAG = re.compile(r"^<artifact-content-authored-by-others/>\n", re.MULTILINE)


class Reference(dict):
    """main's latest logged request: sessionId, at (epoch seconds), system, tools, hashes (one per message) and
    messages (hash to message, for those main's transcript still holds)."""


def message_hash(message: dict) -> str:
    """How Claude Code names a message in its request log: SHA-256 of role and content, keys sorted, no whitespace."""
    content = [{k: v for k, v in block.items() if k != "cache_control"} if isinstance(block, dict) else block for block in message["content"]] \
        if isinstance(message.get("content"), list) else message.get("content")
    return hashlib.sha256(json.dumps({"role": message.get("role"), "content": content}, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8", "surrogatepass")).hexdigest()


def _forms(message: dict):
    """Each way a transcript record's content may have been sent: as stored, and, for a string, as one text block."""
    content = message.get("content")
    yield content
    if isinstance(content, str):
        yield [{"type": "text", "text": content}]


def _named(message: dict) -> dict[str, dict]:
    """The hashes a request may name a transcript record's message by, each with the message as it would have been sent."""
    out = {}
    for content in _forms(message):
        plain = {"role": message.get("role"), "content": content}
        for ascii_ in (False, True):
            out[hashlib.sha256(json.dumps(plain, sort_keys=True, separators=(",", ":"), ensure_ascii=ascii_).encode("utf-8", "surrogatepass")).hexdigest()] = plain
    return out


def _epoch(stamp: str) -> float:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def latest_request(transcript: Path) -> Reference | None:
    """Rebuilds main's most recent main-thread request from the api-request records in its transcript.
    A request is stored as the earlier request it extends (base), how many of that one's messages it keeps, and
    the hashes of what it adds; each message is stored once, under its hash."""
    size = transcript.stat().st_size
    offset = last_boundary_offset(transcript, 64 * 1024 * 1024)
    start = offset if offset is not None else max(0, size - SCAN_FALLBACK_BYTES)
    requests: dict[str, dict] = {}
    blobs: dict[str, dict] = {}
    shapes: dict[str, dict] = {}
    order: list[str] = []
    recorded: dict[str, dict] = {}  # ordinary user and assistant records of the transcript, by the hash a request names them with
    with transcript.open("rb") as file:
        file.seek(start)
        for line in file:
            head = line[:80]
            if b'"type":"api-request"' in head:
                kind = "request"
            elif b'"type":"api-request-blob"' in head:
                kind = "blob"
            elif b'"type":"api-request-shape"' in head:
                kind = "shape"
            elif b'"message":{"role":' in line[:2000] or b'"message":{"' in line[:2000]:
                kind = "record"
            else:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if kind == "blob":
                blobs[record["hash"]] = record["message"]
            elif kind == "shape":
                shapes[record["shapeHash"]] = record["shape"]
            elif kind == "record":
                message = record.get("message")
                if isinstance(message, dict) and message.get("role") in ("user", "assistant") and "content" in message:
                    try:
                        recorded.update(_named(message))
                    except (ValueError, TypeError):
                        continue  # one odd record must not switch the splice off
            elif record.get("querySource") == "repl_main_thread":
                requests[record["id"]] = record
                order.append(record["id"])
    hashes: dict[str, list[str]] = {}
    for request_id in order:
        record = requests[request_id]
        base = record.get("base")
        if not base:
            hashes[request_id] = list(record["tail"])
        elif base in hashes:
            hashes[request_id] = hashes[base][:record["keep"]] + record["tail"]
    for request_id in reversed(order):
        record = requests[request_id]
        shape = shapes.get(record.get("shapeHash"))
        if request_id in hashes and shape:
            held = {h: blobs.get(h) or recorded.get(h) for h in hashes[request_id]}
            return Reference(sessionId=record["sessionId"], at=_epoch(record["timestamp"]), system=shape.get("system"),
                             tools=shape.get("tools"), hashes=hashes[request_id], messages={h: m for h, m in held.items() if m is not None})
    return None


def _blocks(content) -> list:
    return [{"type": "text", "text": content}] if isinstance(content, str) else list(content or [])


def _comparable(message: dict) -> str:
    """The message with harness-tag lines stripped, content as blocks and cache markers dropped."""
    blocks = []
    for block in _blocks(message.get("content")):
        if isinstance(block, dict):
            block = {key: value for key, value in block.items() if key != "cache_control"}
            if isinstance(block.get("text"), str):
                block["text"] = HARNESS_TAG.sub("", block["text"])
        blocks.append(block)
    return json.dumps({"role": message.get("role"), "content": blocks}, sort_keys=True, ensure_ascii=False)


def _adapted(main_message: dict, fork_message: dict) -> dict:
    """main's message in the shape the fork wrote its own: blocks where the fork has blocks, and the fork's other keys."""
    content = main_message.get("content")
    if not isinstance(fork_message.get("content"), str) and isinstance(content, str):
        content = _blocks(content)
    if isinstance(content, list) and content and isinstance(fork_message.get("content"), list) and fork_message["content"]:
        marker = fork_message["content"][-1].get("cache_control") if isinstance(fork_message["content"][-1], dict) else None
        if marker and isinstance(content[-1], dict) and "cache_control" not in content[-1]:
            content = [*content[:-1], {**content[-1], "cache_control": marker}]  # the fork's own breakpoint stays where it was
    return {**fork_message, "content": content}


def _tool_ids(messages: list[dict], kind: str, key: str) -> set[str]:
    ids = set()
    for message in messages:
        for block in _blocks(message.get("content")):
            if isinstance(block, dict) and block.get("type") == kind and isinstance(block.get(key), str):
                ids.add(block[key])
    return ids


def splice(body: dict, reference: Reference, expected_session: str | None, now: float) -> tuple[dict, str]:
    """Returns the body with main's prefix spliced in, and a note. The body comes back as it was, with the reason
    in a note that starts with "skipped", whenever anything is in doubt."""
    messages, tools = body.get("messages"), body.get("tools")
    if not isinstance(messages, list) or not messages or not isinstance(tools, list) or not tools:
        return body, "skipped: no messages or tools"
    if expected_session is None:
        return body, "skipped: no session known for main"
    if reference["sessionId"] != expected_session:
        return body, "skipped: main's logged request belongs to another session"
    if now - reference["at"] > CACHE_LIFETIME_S:
        return body, "skipped: main's logged request is older than the cache lifetime"
    hashes, held = reference["hashes"], reference["messages"]
    k = 0
    while k < min(len(hashes), len(messages)):
        if message_hash(messages[k]) != hashes[k]:
            main_message = held.get(hashes[k])
            if main_message is None or _comparable(messages[k]) != _comparable(main_message):
                break
        k += 1
    if k == 0:
        return body, "skipped: the fork's first message does not correspond to main's"
    prefix = [_adapted(held[hashes[i]], messages[i]) if message_hash(messages[i]) != hashes[i] else messages[i] for i in range(k)]
    tail = messages[k:]
    stray = _tool_ids(tail, "tool_result", "tool_use_id") - _tool_ids(prefix + tail, "tool_use", "id")
    if stray:
        return body, f"skipped: the tail answers tool calls the prefix does not hold: {sorted(stray)[:3]}"
    main_tools = {tool["name"]: tool for tool in reference["tools"] or [] if isinstance(tool, dict) and isinstance(tool.get("name"), str)}
    rewritten, changed = [], 0
    for tool in tools:
        main_tool = main_tools.get(tool.get("name")) if isinstance(tool, dict) else None
        copy = {key: main_tool[key] for key in main_tool if key in tool} if main_tool else None
        if copy is not None and set(copy) == set(tool) and copy != tool:
            rewritten.append(copy)
            changed += 1
        else:
            rewritten.append(tool)
    changed_messages = sum(1 for new, old in zip(prefix, messages[:k]) if new != old)
    if not changed and not changed_messages:
        return body, f"nothing to change: {k} of {len(messages)} messages already match"
    return {**body, "tools": rewritten, "messages": prefix + tail}, \
        f"spliced: {k} of {len(messages)} messages ({changed_messages} replaced), {changed} tool definitions"


class Proxy(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, transcript: Callable[[], Path | None], session: Callable[[], str | None],
                 upstream: str = UPSTREAM, capture: bool = False):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.transcript, self.session, self.upstream, self.capture = transcript, session, upstream, capture
        self.notes: deque[str] = deque(maxlen=50)
        self.captured: list[bytes] = []  # the requests as the fork sent them, kept only when asked, for tests and diagnosis
        self._cached: tuple[float, Path, Reference | None] | None = None

    def reference(self) -> Reference | None:
        """Main's latest logged request, read at most every REFERENCE_TTL_S seconds."""
        path = self.transcript()
        if path is None:
            return None
        now = time.monotonic()
        if self._cached and self._cached[1] == path and now - self._cached[0] < REFERENCE_TTL_S:
            return self._cached[2]
        try:
            reference = latest_request(path)
        except (OSError, KeyError, ValueError) as error:
            log.warning("splice skipped: cannot read main's logged request: %s", error)
            reference = None
        self._cached = (now, path, reference)
        return reference

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
        target = urlsplit(self.path)
        if not self.path.startswith("/") or target.scheme or target.netloc:
            # Only an origin-form path is forwarded, so a client cannot name another host or scheme.
            self.send_error(400, "the request target must be a path")
            self.close_connection = True
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or "transfer-encoding" in self.headers:
            self.send_error(400, "a Content-Length body is required")
            self.close_connection = True
            return
        body = self.rfile.read(length) if length else b""
        if self.command == "POST" and urlsplit(self.path).path == "/v1/messages":
            if self.server.capture:
                self.server.captured = [*self.server.captured[-3:], body]
            body = self._spliced(body)
        url = urlsplit(self.server.upstream)
        connect = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        upstream = connect(url.hostname, url.port, timeout=300)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        try:
            upstream.request(self.command, self.path, body=body or None, headers=headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP_BY_HOP | REPLY_ONLY:
                    self.send_header(key, value)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while chunk := response.read1(8192):
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (OSError, http.client.HTTPException) as error:
            log.warning("cache splice proxy: %s", error)
            self.close_connection = True
        finally:
            upstream.close()

    def _spliced(self, raw: bytes) -> bytes:
        try:
            body = json.loads(raw)
            reference = self.server.reference()
            if not isinstance(body, dict) or reference is None:
                self._note("skipped: no logged request of main's, or the body is not an object")
                return raw
            result, note = splice(body, reference, self.server.session(), time.time())
            self._note(note)
            return raw if result is body else json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode()
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            self._note(f"skipped: {error!r}")
            return raw

    def _note(self, note: str) -> None:
        self.server.notes.append(note)
        if note.startswith("skipped"):
            log.warning("splice %s", note)


def serve_in_background(transcript: Callable[[], Path | None], session: Callable[[], str | None],
                        upstream: str = UPSTREAM, capture: bool = False) -> Proxy:
    proxy = Proxy(transcript, session, upstream, capture)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    return proxy
