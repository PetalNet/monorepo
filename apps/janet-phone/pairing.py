"""Device credentials for the call bridge, and the page that pairs a phone with it."""

import base64
import hashlib
import html
import io
import json
import logging
import os
import secrets
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

log = logging.getLogger("janet-phone")
MAX_BODY = 4096


def bearer(header: str | None) -> str:
    return header[7:] if header and header.startswith("Bearer ") else ""


class Devices:
    """The phones that may call. The file holds a hash of each device's token, never the token, and is
    read on every check, so removing an entry revokes that phone at once."""

    def __init__(self, path: Path):
        self.path, self._lock = path, threading.Lock()

    def _load(self) -> dict[str, dict]:
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}

    def _save(self, devices: dict[str, dict]) -> None:
        partial = self.path.with_suffix(".tmp")
        partial.write_text(json.dumps(devices, indent=2) + "\n")
        os.replace(partial, self.path)

    def name_of(self, token: str) -> str | None:
        """The name of the device this token belongs to, or None when no device holds it."""
        if not token:
            return None
        device = self._load().get(hashlib.sha256(token.encode()).hexdigest())
        return None if device is None else device["name"]

    def add(self, name: str, by: str) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            devices = self._load()
            devices[hashlib.sha256(token.encode()).hexdigest()] = {
                "name": " ".join(name.split())[:80] or "phone", "paired_by": by,
                "paired": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            self._save(devices)
        return token

    def revoke(self, prefix: str) -> list[str]:
        """Removes every device whose id starts with the prefix. Returns their names."""
        with self._lock:
            devices = self._load()
            gone = [key for key in devices if prefix and key.startswith(prefix)]
            names = [devices.pop(key)["name"] for key in gone]
            if gone:
                self._save(devices)
        return names

    def listing(self) -> list[tuple[str, dict]]:
        return [(key[:12], device) for key, device in self._load().items()]


class Codes:
    """One-time pairing codes. A code works once, for a few minutes, and lives only in memory."""

    def __init__(self, ttl_s: int):
        self.ttl_s, self._codes, self._lock = ttl_s, {}, threading.Lock()

    def issue(self, by: str, now: float | None = None) -> tuple[str, int]:
        now = time.time() if now is None else now
        code = secrets.token_urlsafe(16)
        with self._lock:
            self._codes = {c: v for c, v in self._codes.items() if v[0] > now}
            self._codes[code] = (now + self.ttl_s, by)
        return code, int(now + self.ttl_s)

    def redeem(self, code: str, now: float | None = None) -> str | None:
        """Who issued the code, when it is valid. It is spent either way."""
        now = time.time() if now is None else now
        with self._lock:
            expires, by = self._codes.pop(code, (0, ""))
        return by if expires > now else None


def pairing_link(url: str, code: str, expires: int, access: dict) -> str:
    """What the phone opens to pair: where the bridge is, how to get through Cloudflare Access, and
    the one-time code. The device token itself is never shown; the phone fetches it with the code."""
    payload = {"url": url, "code": code, "cf_id": access["client_id"], "cf_secret": access["client_secret"],
               "expires": expires}
    return "janetcall://pair?u=" + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def qr_svg(text: str) -> str:
    import qrcode
    import qrcode.image.svg

    out = io.BytesIO()
    qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2).save(out)
    return out.getvalue().decode()


PAGE = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pair a phone with Janet</title>
<style>
:root {{ color-scheme: light dark; --bg: #fff; --fg: #111; }}
:root[data-theme=dark] {{ --bg: #111; --fg: #eee; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme=light]) {{ --bg: #111; --fg: #eee; }} }}
body {{ background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 3rem auto;
  padding: 0 1rem; text-align: center; }}
.qr {{ background: #fff; display: inline-block; padding: .5rem; border-radius: .5rem; }}
a.button, button {{ display: inline-block; margin: .5rem; padding: .6rem 1rem; border: 1px solid currentColor;
  border-radius: .5rem; background: none; color: inherit; font: inherit; text-decoration: none; cursor: pointer; }}
</style>
<h1>Pair a phone with Janet</h1>
<p>Install Janet Call on the phone, then scan this code with the phone's camera.</p>
<div class="qr">{qr}</div>
<p><a class="button" href="{link}">Pair this phone</a></p>
<p>The code works once and expires in {minutes} minutes. Reload for a new one.</p>
<p>Signed in as {user}.</p>
<button onclick="var r=document.documentElement;r.dataset.theme=getComputedStyle(r).getPropertyValue('--bg').trim()=='#111'?'light':'dark'">Light / dark</button>
</html>
"""


def serve(listen: str, devices: Devices, codes: Codes, *, url: str, access_file: str, users: list[str],
          page_path: str = "/pair", routes: dict | None = None) -> ThreadingHTTPServer:
    """The bridge's plain-HTTP side: the pairing page, the pairing exchange, and any extra POST routes.

    The pairing page (GET page_path) must sit behind single sign-on: it trusts the proxy's X-authentik-username header.
    POST /v1/call/pair sits behind Cloudflare Access like the call itself.
    """

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status: int, body: str, kind: str = "application/json") -> None:
            data = body.encode()
            self.send_response(status)
            self.send_header("content-type", kind)
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            user = self.headers.get("X-authentik-username", "")
            if urlsplit(self.path).path != page_path:
                return self._send(HTTPStatus.NOT_FOUND, "{}")
            if not user or user not in users:
                return self._send(HTTPStatus.FORBIDDEN, "{}")
            code, expires = codes.issue(user)
            link = pairing_link(url, code, expires, json.loads(Path(access_file).read_text()))
            page = PAGE.format(qr=qr_svg(link), link=html.escape(link), minutes=codes.ttl_s // 60, user=html.escape(user))
            log.info("pairing code issued")
            self._send(HTTPStatus.OK, page, "text/html; charset=utf-8")

        def do_POST(self):
            path = urlsplit(self.path).path
            try:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}") if 0 <= length <= MAX_BODY else None
            except ValueError:
                body = None
            if not isinstance(body, dict):
                return self._send(HTTPStatus.BAD_REQUEST, "{}")
            if path == "/v1/call/pair":
                by = codes.redeem(str(body.get("code", "")))
                if by is None:
                    return self._send(HTTPStatus.FORBIDDEN, '{"error": "the pairing code is not valid"}')
                token = devices.add(str(body.get("name", "")), by)
                # The id only: the device's name and who paired it are in the registry, not the log.
                log.info("paired device %s", hashlib.sha256(token.encode()).hexdigest()[:12])
                return self._send(HTTPStatus.OK, json.dumps({"token": token}))
            if routes and path in routes:
                status, reply = routes[path](self.headers, body)
                return self._send(status, json.dumps(reply))
            self._send(HTTPStatus.NOT_FOUND, "{}")

    host, _, port = listen.rpartition(":")
    server = ThreadingHTTPServer((host, int(port)), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
