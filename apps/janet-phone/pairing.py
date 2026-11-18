"""Device credentials for the call bridge, and the page that pairs a phone with it."""

import base64
import fcntl
import hashlib
import hmac
import html
import io
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

log = logging.getLogger("janet-phone")
MAX_BODY = 4096
MAX_CODES = 8
PAIR_ATTEMPTS_A_MINUTE = 10  # for one caller
PAIR_ATTEMPTS_A_MINUTE_IN_ALL = 120
SIGNIN_PATH = "/v1/call/pair/signin"


def bearer(header: str | None) -> str:
    return header[7:] if header and header.startswith("Bearer ") else ""


class Devices:
    """The phones that may call. The file holds a hash of each device's token, never the token, and is
    read on every check, so removing an entry revokes that phone at once."""

    def __init__(self, path: Path):
        self.path = path

    def _locked(self):
        """One writer at a time, across processes: the bridge and a --revoke run are separate ones."""
        lock = open(self.path.with_suffix(".lock"), "w")
        fcntl.flock(lock, fcntl.LOCK_EX)
        return lock

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
        with self._locked():
            devices = self._load()
            devices[hashlib.sha256(token.encode()).hexdigest()] = {
                "name": " ".join(name.split())[:80] or "phone", "paired_by": by,
                "paired": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            self._save(devices)
        return token

    def revoke(self, prefix: str) -> str | None:
        """Removes the one device whose id starts with the prefix and returns its name. Removes
        nothing when the prefix matches no device or more than one."""
        with self._locked():
            devices = self._load()
            matches = [key for key in devices if prefix and key.startswith(prefix)]
            if len(matches) != 1:
                return None
            name = devices.pop(matches[0])["name"]
            self._save(devices)
        return name

    def listing(self) -> list[tuple[str, dict]]:
        return [(key[:12], device) for key, device in self._load().items()]


class Limit:
    """At most so many events a minute for each key, counted over the last sixty seconds."""

    def __init__(self, a_minute: int):
        self.a_minute, self._times, self._lock = a_minute, {}, threading.Lock()

    def allows(self, key: str = "", now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            self._times = {k: recent for k, times in self._times.items() if (recent := [t for t in times if now - t < 60])}
            times = self._times.setdefault(key, [])
            if len(times) >= self.a_minute:
                return False
            times.append(now)
            return True


class Codes:
    """One-time pairing codes. A code works once, for a few minutes, and lives only in memory."""

    def __init__(self, ttl_s: int):
        self.ttl_s, self._codes, self._lock = ttl_s, {}, threading.Lock()

    def issue(self, by: str, now: float | None = None) -> tuple[str, int]:
        now = time.time() if now is None else now
        code = secrets.token_urlsafe(16)
        with self._lock:
            live = [(c, v) for c, v in self._codes.items() if v[0] > now]
            self._codes = dict(live[-(MAX_CODES - 1):])  # reloading the page cannot pile codes up
            self._codes[code] = (now + self.ttl_s, by)
        return code, int(now + self.ttl_s)

    def redeem(self, code: str, now: float | None = None) -> str | None:
        """Who issued the code, when it is valid. It is spent either way."""
        now = time.time() if now is None else now
        with self._lock:
            expires, by = self._codes.pop(code, (0, ""))
        return by if expires > now else None


@dataclass(frozen=True)
class SignIn:
    """The single-sign-on client a phone signs in through: an OAuth 2 public client with PKCE.

    The phone knows none of this. It opens the bridge's sign-in address with its PKCE challenge,
    the bridge sends the browser on to authorize_url, and single sign-on hands the phone a code at
    redirect_uri. The bridge trades that code and the phone's verifier at token_url, then asks
    userinfo_url whose sign-in it was. token_url and userinfo_url can be the provider's own
    listener rather than its public address.
    """

    authorize_url: str
    token_url: str
    userinfo_url: str
    client_id: str
    redirect_uri: str

    def authorize(self, challenge: str, state: str) -> str:
        return self.authorize_url + "?" + urlencode({
            "response_type": "code", "client_id": self.client_id, "redirect_uri": self.redirect_uri,
            "scope": "openid profile", "code_challenge": challenge, "code_challenge_method": "S256", "state": state})

    def username(self, code: str, verifier: str) -> str | None:
        """Who signed in, or None when single sign-on refuses the code or the verifier. Raises
        OSError when single sign-on cannot be reached."""
        form = urlencode({"grant_type": "authorization_code", "code": code, "code_verifier": verifier,
                          "client_id": self.client_id, "redirect_uri": self.redirect_uri}).encode()
        try:
            granted = self._json(urllib.request.Request(self.token_url, data=form))
            who = self._json(urllib.request.Request(
                self.userinfo_url, headers={"Authorization": f"Bearer {granted['access_token']}"}))
        except urllib.error.HTTPError as error:
            if error.code in (400, 401, 403):
                return None
            raise
        except (ValueError, KeyError, TypeError) as error:
            raise OSError("single sign-on gave an answer that is not usable") from error
        name = who.get("preferred_username")
        return name if isinstance(name, str) and name else None

    @staticmethod
    def _json(request: urllib.request.Request) -> dict:
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", "janet-phone")
        with urllib.request.urlopen(request, timeout=10) as response:
            answer = json.loads(response.read(1 << 16))
        if not isinstance(answer, dict):
            raise ValueError("not a JSON object")
        return answer


def app_link(url: str, code: str, expires: int) -> str:
    """What the app opens to pair: where the bridge is and a one-time code. No lasting secret is in
    it; the phone trades the code for its device token and the Access credentials over TLS."""
    payload = {"url": url, "code": code, "expires": expires}
    return "janetcall://pair?u=" + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def tap_link(url: str, code: str, expires: int) -> str:
    """The same pairing as a web address, which a chat message can carry and a camera can open. It
    leads to a page on the bridge with one button that opens the app."""
    return f"https://{urlsplit(url).netloc}/v1/call/pair?c={code}&e={expires}"


def qr_svg(text: str) -> str:
    import qrcode
    import qrcode.image.svg

    out = io.BytesIO()
    qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2).save(out)
    return out.getvalue().decode()


OPEN = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pair this phone with Janet</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ font: 18px/1.5 system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; text-align: center; }}
a.button {{ display: inline-block; margin: 1rem; padding: .9rem 1.4rem; border: 1px solid currentColor; border-radius: .6rem;
  color: inherit; text-decoration: none; font-weight: 600; }}
</style>
<h1>Pair this phone with Janet</h1>
<p><a class="button" href="{link}">Open Janet Call</a></p>
<p>Install Janet Call first if the button does nothing. The link works once and for a few minutes.</p>
</html>
"""

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
<p>Install Janet Call on the phone, then scan this code with the phone's camera and tap the button it shows.</p>
<div class="qr">{qr}</div>
<p><a class="button" href="{link}">Pair this phone</a></p>
<p>The code works once and expires in {minutes} minutes. Reload for a new one.</p>
<p>Signed in as {user}.</p>
<button onclick="var r=document.documentElement;r.dataset.theme=getComputedStyle(r).getPropertyValue('--bg').trim()=='#111'?'light':'dark'">Light / dark</button>
</html>
"""


def serve(listen: str, devices: Devices, codes: Codes, *, url: str, access_file: str, users: list[str],
          proxy_secret_file: str, page_path: str = "/pair", routes: dict | None = None,
          on_paired=None, signin: SignIn | None = None) -> ThreadingHTTPServer:
    """The bridge's plain-HTTP side: the pairing page, the pairing exchange, and any extra POST routes.

    The pairing page (GET page_path) is for the single-sign-on proxy alone. A request must carry the
    proxy's own secret in X-Janet-Pair-Proxy, which the proxy adds after it has signed the visitor in;
    only then is its X-authentik-username believed. Another process on the same host can reach this
    listener, and without the secret it gets nothing.
    POST /v1/call/pair needs a live one-time code and nothing else, and GET /v1/call/pair is the page
    a pairing link lands on. Both are reachable without Cloudflare Access, since a phone that is not
    paired has no Access credentials yet. The exchange is limited to ten attempts a minute for each caller and 120 in all.
    With signin set, GET /v1/call/pair/signin sends a phone's browser to single sign-on, and POST
    /v1/call/pair/signin pairs the phone with the code single sign-on gave it, for the same users
    and under the same limits. Without it both answer 404.
    """

    attempts, attempts_in_all = Limit(PAIR_ATTEMPTS_A_MINUTE), Limit(PAIR_ATTEMPTS_A_MINUTE_IN_ALL)

    def from_proxy(headers) -> bool:
        try:
            secret = Path(proxy_secret_file).read_text().strip()
        except OSError:
            return False
        return bool(secret) and hmac.compare_digest(headers.get("X-Janet-Pair-Proxy", "").encode(), secret.encode())

    class Handler(BaseHTTPRequestHandler):
        timeout = 10  # a stalled connection does not hold a thread

        def log_message(self, *args):
            pass

        def _send(self, status: int, body: str, kind: str = "application/json", location: str = "") -> None:
            data = body.encode()
            self.send_response(status)
            if location:
                self.send_header("location", location)
            self.send_header("content-type", kind)
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            self.send_header("x-frame-options", "DENY")
            # Nothing may be loaded or run from these pages: their addresses can hold a pairing code.
            self.send_header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
            self.send_header("cross-origin-opener-policy", "same-origin")  # a page that opened this one loses its handle
            self.send_header("referrer-policy", "no-referrer")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            user = self.headers.get("X-authentik-username", "")
            address = urlsplit(self.path)
            if address.path == "/v1/call/pair":
                # Where a tapped or scanned link lands: one button that hands the code to the app.
                # Loading this page spends nothing, so a chat client fetching a preview does no harm.
                query = parse_qs(address.query)
                code, expires = query.get("c", [""])[0], query.get("e", [""])[0]
                if not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", code) or not re.fullmatch(r"[0-9]{1,12}", expires):
                    return self._send(HTTPStatus.NOT_FOUND, "{}")
                page = OPEN.format(link=html.escape(app_link(url, code, int(expires))))
                return self._send(HTTPStatus.OK, page, "text/html; charset=utf-8")
            if address.path == SIGNIN_PATH and signin is not None:
                # Nothing is kept: the challenge and the state ride through single sign-on and come
                # back to the phone, which alone holds the verifier.
                query = parse_qs(address.query)
                challenge, state = query.get("challenge", [""])[0], query.get("state", [""])[0]
                if not re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", state):
                    return self._send(HTTPStatus.NOT_FOUND, "{}")
                return self._send(HTTPStatus.FOUND, "{}", location=signin.authorize(challenge, state))
            if address.path != page_path:
                return self._send(HTTPStatus.NOT_FOUND, "{}")
            # A page on another site must not make the owner's browser mint codes behind his back, but
            # he must be able to arrive here from the sign-on page or from a link: a top-level
            # navigation is let through whatever site it came from, a fetch or a frame is not.
            navigation = ((self.headers.get("Sec-Fetch-Mode"), self.headers.get("Sec-Fetch-Dest")) == ("navigate", "document")
                          and "Sec-Purpose" not in self.headers)  # a speculative load mints nothing
            cross_site = self.headers.get("Sec-Fetch-Site", "none") not in ("none", "same-origin") and not navigation
            if not from_proxy(self.headers) or not user or user not in users or cross_site:
                return self._send(HTTPStatus.FORBIDDEN, "{}")
            code, expires = codes.issue(user)
            log.info("pairing code issued")
            if parse_qs(address.query).get("format") == ["link"]:  # for the operator, who sends it on
                return self._send(HTTPStatus.OK, tap_link(url, code, expires) + "\n", "text/plain; charset=utf-8")
            page = PAGE.format(qr=qr_svg(tap_link(url, code, expires)), link=html.escape(app_link(url, code, expires)),
                               minutes=codes.ttl_s // 60, user=html.escape(user))
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
            if path == "/v1/call/pair" or (path == SIGNIN_PATH and signin is not None):
                # Counted for each caller, by the address Cloudflare reports, so that one caller
                # cannot use up the owner's attempts, and for everyone together as a ceiling.
                caller = self.headers.get("Cf-Connecting-Ip", "")
                if not attempts.allows(caller) or not attempts_in_all.allows():
                    return self._send(HTTPStatus.TOO_MANY_REQUESTS, '{"error": "too many pairing attempts; wait a minute"}')
                try:  # before the code is spent: a phone must never pair and then be left without these
                    access = json.loads(Path(access_file).read_text())
                    reply = {"cf_id": access["client_id"], "cf_secret": access["client_secret"]}
                except (OSError, ValueError, KeyError):
                    log.warning("pairing refused: the Access credentials file is unusable")
                    return self._send(HTTPStatus.SERVICE_UNAVAILABLE, "{}")
                code = str(body.get("code", ""))
                if path == "/v1/call/pair":
                    by = codes.redeem(code)
                    if by is None:
                        return self._send(HTTPStatus.FORBIDDEN, '{"error": "the pairing code is not valid"}')
                else:
                    verifier = str(body.get("verifier", ""))
                    by = None
                    if 0 < len(code) <= 512 and re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier):
                        try:
                            by = signin.username(code, verifier)
                        except OSError as error:
                            log.warning("sign-in refused: single sign-on did not answer: %s", type(error).__name__)
                            return self._send(HTTPStatus.SERVICE_UNAVAILABLE, "{}")
                    if by is None:
                        return self._send(HTTPStatus.FORBIDDEN, '{"error": "the sign-in is not valid"}')
                    if by not in users:
                        log.info("sign-in refused: the account may not pair a phone")
                        return self._send(HTTPStatus.FORBIDDEN, '{"error": "this account may not pair a phone"}')
                token = devices.add(str(body.get("name", "")), by)
                # The id only: the device's name and who paired it are in the registry, not the log.
                log.info("paired device %s", hashlib.sha256(token.encode()).hexdigest()[:12])
                if on_paired is not None:
                    on_paired(devices.name_of(token), by)
                # The Access service token travels here, over TLS and once, and never in a link.
                return self._send(HTTPStatus.OK, json.dumps({"token": token, **reply}))
            if routes and path in routes:
                status, reply = routes[path](self.headers, body)
                return self._send(status, json.dumps(reply))
            self._send(HTTPStatus.NOT_FOUND, "{}")

    host, _, port = listen.rpartition(":")
    server = ThreadingHTTPServer((host, int(port)), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
