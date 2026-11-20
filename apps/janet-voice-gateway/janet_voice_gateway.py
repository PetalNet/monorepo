import argparse
import base64
import hashlib
import hmac
import http.client
import json
import logging
import re
import signal
import socket
import struct
import threading
import time
import tomllib
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

__version__ = "0.1.0"

MAX_BODY = 64 * 1024
_CONVERSATION = re.compile(r"/v1/conversations/([0-9a-f]{12})/(turns|interrupt|end)")
_ACTIONS = {"turns": "turns", "interrupt": "interrupt", "end": "end"}


def head_path(path: str) -> str | None:
    """The head route a request path names, rebuilt from its checked parts; None for any other path."""
    if path == "/v1/conversations":
        return "/v1/conversations"
    match = _CONVERSATION.fullmatch(path)
    if match is None:
        return None
    # The id is re-rendered from its numeric value, so nothing the caller typed is sent on.
    return f"/v1/conversations/{int(match[1], 16):012x}/{_ACTIONS[match[2]]}"


class VoiceAsleep(Exception):
    pass


class VoiceError(Exception):
    pass


@dataclass(frozen=True)
class Voice:
    host: str
    port: int
    name: str
    mac: bytes
    broadcast: tuple[str, int]
    connect_timeout: float = 1.5
    # A cold voice model can take minutes to load before the first chunk.
    read_timeout: float = 300.0

    def connect(self) -> socket.socket:
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.connect_timeout)
        except OSError as error:
            raise VoiceAsleep(str(error)) from None
        sock.settimeout(self.read_timeout)
        return sock

    def awake(self) -> bool:
        try:
            self.connect().close()
        except VoiceAsleep:
            return False
        return True

    def wake(self) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                sock.sendto(b"\xff" * 6 + self.mac * 16, self.broadcast)
        except OSError as error:
            logging.warning("wake: %s", error)
            return False
        return True

    def open(self, text: str) -> "Synthesis":
        """Connects and sends the request. Raises VoiceAsleep when nothing answers."""
        sock = self.connect()
        data = json.dumps({"text": text, "voice": {"name": self.name}}).encode()
        header = json.dumps({"type": "synthesize", "data_length": len(data), "payload_length": 0}).encode()
        try:
            sock.sendall(header + b"\n" + data)
        except OSError as error:
            sock.close()
            raise VoiceAsleep(str(error)) from None
        return Synthesis(sock)


class Synthesis:
    def __init__(self, sock: socket.socket):
        self._sock = sock

    def wav(self) -> bytes:
        """Reads the whole reply and returns it as a mono PCM16 WAV file."""
        pcm, rate = bytearray(), 0
        with self._sock, self._sock.makefile("rb") as reader:
            while True:
                try:
                    kind, fields, payload = _read_event(reader)
                except (OSError, ValueError) as error:
                    raise VoiceError(str(error)) from None
                if kind == "audio-chunk":
                    if (fields.get("width"), fields.get("channels")) != (2, 1):
                        raise VoiceError("the voice server must send mono 16-bit audio")
                    rate = fields["rate"]
                    pcm += payload
                elif kind == "audio-stop":
                    return wav_file(rate or 24000, bytes(pcm))
                elif kind == "error":
                    raise VoiceError(fields.get("text", "voice server error"))


def _read_event(reader) -> tuple[str, dict, bytes]:
    line = reader.readline()
    if not line:
        raise VoiceError("the voice server closed the connection")
    header = json.loads(line)
    fields = dict(header.get("data") or {})
    if header.get("data_length"):
        fields.update(json.loads(_exactly(reader, header["data_length"])))
    return header["type"], fields, _exactly(reader, header.get("payload_length") or 0)


def _exactly(reader, length: int) -> bytes:
    data = reader.read(length)
    if len(data) != length:
        raise VoiceError("the voice server closed the connection")
    return data


def wav_file(rate: int, pcm: bytes) -> bytes:
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1, 1, rate, rate * 2, 2, 16,
                         b"data", len(pcm))
    return header + pcm


# DigestInfo for SHA-256, the fixed prefix of an RSASSA-PKCS1-v1_5 signature block (RFC 8017, 9.2).
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class AccessVerifier:
    """Checks the signed token Cloudflare Access adds to every request it lets through.

    A request that reached this process some other way (another container on the proxy's
    host, a client on the same network) has no such token, so Access cannot be skipped.
    """

    def __init__(self, certs_url: str, audience: str, issuer: str):
        self._certs_url, self._audience, self._issuer = certs_url, audience, issuer
        self._keys: dict[str, tuple[int, int]] = {}
        self._fetched = 0.0
        self._lock = threading.Lock()

    def _key(self, kid: str) -> tuple[int, int] | None:
        with self._lock:
            # Cloudflare rotates its keys, so an unknown key id means fetch again, at most once a minute.
            if kid not in self._keys and time.monotonic() - self._fetched > 60:
                self._fetched = time.monotonic()
                try:
                    with urllib.request.urlopen(self._certs_url, timeout=10) as reply:  # noqa: S310 - from config
                        keys = json.load(reply)["keys"]
                    self._keys = {key["kid"]: (int.from_bytes(_unb64(key["n"])), int.from_bytes(_unb64(key["e"])))
                                  for key in keys if key.get("kty") == "RSA"}
                except (OSError, ValueError, KeyError, TypeError) as error:
                    logging.warning("access: cannot fetch signing keys: %s", error)
            return self._keys.get(kid)

    def valid(self, token: str) -> bool:
        try:
            signed, _, signature = token.rpartition(".")
            header_part, _, claims_part = signed.partition(".")
            header, claims = json.loads(_unb64(header_part)), json.loads(_unb64(claims_part))
            if header.get("alg") != "RS256":
                return False
            key = self._key(header["kid"])
            if key is None:
                return False
            modulus, exponent = key
            size = (modulus.bit_length() + 7) // 8
            digest = hashlib.sha256(signed.encode()).digest()
            expected = b"\x00\x01" + b"\xff" * (size - len(_SHA256_PREFIX) - len(digest) - 3) + b"\x00" + _SHA256_PREFIX + digest
            actual = pow(int.from_bytes(_unb64(signature)), exponent, modulus).to_bytes(size)
            audience = claims.get("aud")
            audiences = audience if isinstance(audience, list) else [audience]
            return (hmac.compare_digest(actual, expected) and self._audience in audiences
                    and claims.get("iss") == self._issuer and float(claims["exp"]) > time.time())
        except (ValueError, KeyError, TypeError, OverflowError):
            return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Seconds a client may stall while sending a request.
    timeout = 30
    token: str
    head: str
    voice: Voice
    access: AccessVerifier | None

    def log_message(self, *_):
        pass

    def _json(self, status: int, body: dict, headers: dict | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        # One request per connection: bytes after this request are never read as another one.
        self.send_header("connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        if self.access is not None and not self.access.valid(self.headers.get("Cf-Access-Jwt-Assertion", "")):
            return False
        return hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + self.token).encode())

    def _read_body(self) -> bytes | None:
        if self.headers.get("Transfer-Encoding"):
            self._json(411, {"error": "send a Content-Length"})
            return None
        length = self.headers.get("Content-Length", "0")
        if not (length.isascii() and length.isdigit()):
            self._json(400, {"error": "bad Content-Length"})
            return None
        if int(length) > MAX_BODY:
            self._json(413, {"error": "body too large"})
            return None
        return self.rfile.read(int(length))

    def _start_stream(self, content_type: str) -> None:
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("cache-control", "no-cache")
        self.send_header("transfer-encoding", "chunked")
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.flush()

    def _chunk(self, data: bytes) -> None:
        if data:
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()


    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "version": __version__})
        if not self._authorized():
            return self._json(401, {"error": "bearer token required"})
        if self.path == "/v1/voice":
            return self._json(200, {"state": "up" if self.voice.awake() else "asleep"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = self._read_body()
        if body is None:
            return
        if not self._authorized():
            return self._json(401, {"error": "bearer token required"})
        if self.path == "/v1/voice/wake":
            return self._json(200, {"sent": self.voice.wake()})
        if self.path == "/v1/tts":
            return self._tts(body)
        route = head_path(self.path)
        if route is not None:
            return self._to_head(route, body)
        self._json(404, {"error": "not found"})

    def _tts(self, body: bytes) -> None:
        try:
            text = json.loads(body or b"{}")["text"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self._json(400, {"error": "text must be a string"})
        try:
            synthesis = self.voice.open(text.strip())
        except VoiceAsleep:
            self.voice.wake()
            return self._json(503, {"error": "the voice host is asleep; a wake packet was sent", "state": "waking"},
                              {"retry-after": "5"})
        # Headers go out before the audio exists: a cold voice model takes longer to load
        # than a proxy waits for response headers.
        self._start_stream("audio/wav")
        try:
            self._chunk(synthesis.wav())
            self.wfile.write(b"0\r\n\r\n")
        except VoiceError as error:
            # No terminating chunk: the client sees a failed transfer, not a short reply.
            logging.warning("voice: %s", error)
        except OSError:
            pass

    def _to_head(self, route: str, body: bytes) -> None:
        url = urlsplit(self.head)
        upstream = http.client.HTTPConnection(url.hostname, url.port, timeout=180)
        try:
            # The caller's own header goes through, so the head checks the token a second time.
            upstream.request("POST", route, body=body, headers={
                "Authorization": self.headers.get("Authorization", ""), "content-type": "application/json",
                "X-Janet-Lab-Token": self.headers.get("X-Janet-Lab-Token", "")})
            response = upstream.getresponse()
            streaming = response.getheader("content-type", "").startswith("text/event-stream")
            if response.status != 200 or not streaming:
                data = response.read()
                self.send_response(response.status)
                # The head answers JSON on every route but a turn. Its header is not copied.
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.send_header("connection", "close")
                self.end_headers()
                self.wfile.write(data)
                return
        except (OSError, http.client.HTTPException) as error:
            upstream.close()
            return self._json(502, {"error": f"the voice head is unreachable: {error}"})
        self._start_stream("text/event-stream")
        try:
            while line := response.readline():
                self._chunk(line)
            self.wfile.write(b"0\r\n\r\n")
        except (OSError, http.client.HTTPException) as error:
            logging.warning("head stream: %s", error)
        finally:
            upstream.close()


def load_config(path: Path) -> tuple[list[str], dict]:
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    voice = raw["voice"]
    host, _, port = voice["wyoming"].rpartition(":")
    mac = bytes.fromhex(voice["mac"].replace(":", "").replace("-", ""))
    if len(mac) != 6:
        raise ValueError("voice.mac must be six bytes")
    bhost, _, bport = voice["broadcast"].rpartition(":")
    if urlsplit(raw["head"]).scheme != "http":
        raise ValueError("head must be an http:// URL")
    access = raw.get("access")
    bound = {
        "token": Path(raw["token_file"]).read_text(encoding="utf-8").strip(),
        "head": raw["head"],
        "access": AccessVerifier(access["certs_url"], access["audience"], access["issuer"]) if access else None,
        "voice": Voice(host, int(port), voice.get("name", "default"), mac, (bhost, int(bport))),
    }
    if not bound["token"]:
        raise ValueError("token_file is empty")
    return raw["listen"], bound


def main() -> None:
    parser = argparse.ArgumentParser(prog="janet-voice-gateway")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    listen, bound = load_config(args.config)
    handler = type("BoundHandler", (Handler,), bound)
    for bind in listen:
        host, _, port = bind.rpartition(":")
        server = ThreadingHTTPServer((host, int(port)), handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        logging.info("listening on %s", bind)
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    stop.wait()


if __name__ == "__main__":
    main()
