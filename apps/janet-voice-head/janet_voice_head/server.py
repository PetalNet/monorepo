import argparse
import hmac
import json
import logging
import os
import re
import secrets
import signal
import threading
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__, web_guard
from .conversation import LEAST_PRIVILEGED, TIERS
from .head import ApiError, Config, Head
from .merge import Hub

MAX_BODY = 64 * 1024
HANDLER_TIMEOUT_S = 30
_CONVERSATION = re.compile(r"/v1/conversations/([0-9a-f]{12})/(turns|interrupt|end)")


def load_or_create_token(path: Path) -> str:
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return path.read_text(encoding="utf-8").strip()
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        token = secrets.token_urlsafe(32)
        file.write(token + "\n")
    return token


def load_config(path: Path) -> tuple[Config, list[str], Path]:
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    hub = raw.pop("hub")
    listen, token_file = raw.pop("listen"), Path(raw.pop("token_file"))
    if raw.get("soft_merge", "asks") not in ("asks", "every"):
        raise ValueError("soft_merge must be asks or every")
    if unknown := set(raw.get("web_tools", [])) - web_guard.TOOLS:
        raise ValueError(f"web_tools may only name {sorted(web_guard.TOOLS)}, not {sorted(unknown)}")
    config = Config(
        state_dir=Path(raw.pop("state_dir")),
        hub=Hub(hub["url"], Path(hub["token_file"]), Path(hub["state_file"]), raw["main_cwd"]),
        **raw)
    return config, listen, token_file


class Handler(BaseHTTPRequestHandler):
    head: Head
    token: str
    timeout = HANDLER_TIMEOUT_S

    def log_message(self, *_):
        pass

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        return hmac.compare_digest(self.headers.get("Authorization", "").encode("utf-8", "replace"), f"Bearer {self.token}".encode())

    def _lab_authorized(self) -> bool:
        path = self.head.config.lab_token_file
        if not path:
            return False
        try:
            token = Path(path).read_text().strip()
        except OSError:
            return False
        return bool(token) and hmac.compare_digest(self.headers.get("X-Janet-Lab-Token", "").encode(), token.encode())

    def _body(self) -> dict:
        raw_length = self.headers.get("Content-Length", "0").strip()
        if not (raw_length.isascii() and raw_length.isdigit()):
            raise ApiError(400, "Content-Length must be a non-negative integer")
        length = int(raw_length)
        if length > MAX_BODY:
            raise ApiError(413, "body too large")
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError(400, "body must be JSON") from None
        if not isinstance(body, dict):
            raise ApiError(400, "body must be a JSON object")
        return body

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "version": __version__})
        if self.path == "/v1/calls":
            if not self._authorized():
                return self._json(401, {"error": "bearer token required"})
            return self._json(200, self.head.call_status())
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {"error": "bearer token required"})
        try:
            body = self._body()
            if self.path == "/v1/conversations":
                channel, ref = body.get("channel"), body.get("client_ref")
                if not isinstance(channel, str) or not channel:
                    raise ApiError(400, "channel is required")
                if ref is not None and not isinstance(ref, str):
                    raise ApiError(400, "client_ref must be a string")
                tier = body.get("tier", LEAST_PRIVILEGED)
                if tier not in TIERS:
                    raise ApiError(400, "tier must be personal, room or guest")
                verified = self._lab_authorized()
                if self.headers.get("X-Janet-Lab-Token") and not verified:
                    raise ApiError(403, "invalid Parker lab credential")
                if self.head.config.lab_token_file and tier == "personal" and not verified:
                    tier = LEAST_PRIVILEGED
                lab = verified and tier == "personal"
                return self._json(200, {"id": self.head.open(channel, tier, ref, lab_access=lab)})
            match = _CONVERSATION.fullmatch(self.path)
            if match is None:
                raise ApiError(404, "not found")
            conv_id, action = match.groups()
            if self.head._live(conv_id).conv.lab_access and not self._lab_authorized():
                raise ApiError(403, "Parker lab credential required")
            if action == "turns":
                allow_silence = body.get("allow_silence", False)
                if not isinstance(allow_silence, bool):
                    raise ApiError(400, "allow_silence must be a boolean")
                return self._turn(conv_id, _text(body, "text"), allow_silence=allow_silence)
            if action == "interrupt":
                self.head.interrupt(conv_id, _text(body, "heard_text", empty=True))
                return self._json(200, {"ok": True})
            return self._json(200, self.head.end(conv_id, _text(body, "reason", empty=True) or "client"))
        except ApiError as error:
            self._json(error.status, {"error": str(error)})

    def _turn(self, conv_id: str, text: str, *, allow_silence: bool) -> None:
        started = False

        def emit(event: str, data: dict) -> None:
            nonlocal started
            if not started:
                started = True
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.end_headers()
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        try:
            self.head.turn(conv_id, text, emit, allow_silence=allow_silence)
        except ApiError:
            if not started:
                raise


def _text(body: dict, key: str, empty: bool = False) -> str:
    value = body.get(key, "" if empty else None)
    if not isinstance(value, str) or not (empty or value.strip()):
        raise ApiError(400, f"{key} must be a string")
    return value.strip()


def main() -> None:
    parser = argparse.ArgumentParser(prog="janet-voice-head")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config, listen, token_file = load_config(args.config)
    if config.lab_token_file:
        load_or_create_token(Path(config.lab_token_file))
    handler = type("BoundHandler", (Handler,), {"head": Head(config), "token": load_or_create_token(token_file)})
    servers = []
    for bind in listen:
        host, _, port = bind.rpartition(":")
        server = ThreadingHTTPServer((host, int(port)), handler)
        server.daemon_threads = True
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        logging.info("listening on %s", bind)
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    stop.wait()
    handler.head.close()


if __name__ == "__main__":
    main()
