"""Device-bound incoming rings. Only the authenticated bridge ever holds the call reason."""

import base64
import hashlib
import hmac
import ipaddress
import json
import secrets
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import pairing

MAX_PENDING = 32
MAX_REASON = 2000


def root_secret(path: str) -> bytes:
    secret = Path(path).read_text().strip().encode()
    if len(secret) < 32 or b"\r" in secret or b"\n" in secret:
        raise ValueError("ring_secret_file must hold at least 32 bytes of single-line text")
    return secret


def local_listener(listen: str) -> str:
    """A numeric loopback HTTP address; configuration cannot redirect the root credential."""
    host, _, port = listen.rpartition(":")
    address = ipaddress.ip_address(host.strip("[]"))
    if not address.is_loopback or not 0 < int(port) <= 65535:
        raise ValueError("ring control requires a numeric loopback http_listen")
    authority = f"[{address}]" if address.version == 6 else str(address)
    return f"http://{authority}:{int(port)}/v1/call/ring"


def publish(server: str, topic: str, payload: dict, timeout: float) -> None:
    request = urllib.request.Request(server + "/" + topic, json.dumps(payload).encode(),
                                     {"Content-Type": "application/json", "Cache": "no", "Priority": "urgent"})
    with pairing._DIRECT.open(request, timeout=timeout) as response:
        if not 200 <= response.status < 300:
            raise OSError("ntfy refused the ring")


@dataclass
class Ring:
    id: str
    device: str
    reason: str
    expires: float
    deadline: float
    state: str = "pending"
    done: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def remaining(self) -> float:
        return max(0.0, self.deadline - time.monotonic())

    def live(self) -> bool:
        return self.state in ("pending", "answering") and self.remaining() > 0

    def reserve(self) -> bool:
        with self.lock:
            if self.state != "pending" or not self.live():
                return False
            self.state = "answering"
            return True

    def finish(self, state: str) -> bool:
        with self.lock:
            if self.state not in ("pending", "answering"):
                return False
            self.state = state if self.remaining() > 0 else "timeout"
            self.done.set()
            return self.state == state

    def decline(self, state: str) -> bool:
        with self.lock:
            if self.state != "pending" or not self.live():
                return False
            self.state = state
            self.done.set()
            return True

    def snapshot(self) -> dict | None:
        with self.lock:
            if not self.live():
                return None
            return {"id": self.id, "reason": self.reason, "expires": self.expires}


class Rings:
    def __init__(self, devices: pairing.Devices, secret_file: str, server: str, timeout: float):
        self.devices = devices
        self.secret = root_secret(secret_file)
        parsed = urlsplit(server)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("ntfy_url must be an HTTPS server address")
        if not 0 < timeout <= 120:
            raise ValueError("ring_timeout_s must be greater than zero and at most 120")
        self.server, self.timeout = server.rstrip("/"), timeout
        self.pending: dict[str, Ring] = {}
        self.lock = threading.Lock()
        self.control_slots = threading.BoundedSemaphore(MAX_PENDING)

    def topic(self, device: str) -> str:
        digest = hmac.new(self.secret, b"janet-ring:v1:" + device.encode(), hashlib.sha256).digest()
        return "janet-ring-" + base64.urlsafe_b64encode(digest).decode().rstrip("=")

    def pairing_fields(self, token: str) -> dict:
        return {"ring_topic": self.topic(pairing.device_hash(token)), "ntfy_url": self.server}

    def device(self, headers) -> str | None:
        values = headers.get_all("Authorization") or []
        token = pairing.bearer(values[0]) if len(values) == 1 else ""
        return pairing.device_hash(token) if self.devices.name_of(token) is not None else None

    def find(self, device: str, ident) -> Ring | None:
        if not isinstance(ident, str):
            return None
        with self.lock:
            ring = self.pending.get(ident)
            return ring if ring is not None and ring.device == device else None

    def register(self, headers, body) -> tuple[int, dict]:
        device = self.device(headers)
        return (200, {"topic": self.topic(device), "server": self.server}) if device else (403, {})

    def inspect(self, headers, body) -> tuple[int, dict]:
        device = self.device(headers)
        if not device:
            return 403, {}
        ring = self.find(device, body.get("id"))
        snapshot = ring.snapshot() if ring else None
        return (200, snapshot) if snapshot else (409, {})

    def decline(self, headers, body) -> tuple[int, dict]:
        device = self.device(headers)
        if not device:
            return 403, {}
        state = body.get("status", "declined")
        if state not in ("declined", "busy"):
            return 400, {}
        ring = self.find(device, body.get("id"))
        return (200, {"status": state}) if ring and ring.decline(state) else (409, {})

    def control(self, headers, body) -> tuple[int, dict]:
        keys = headers.get_all("X-Janet-Ring-Key") or []
        if len(keys) != 1 or not hmac.compare_digest(keys[0].encode(), self.secret):
            return 403, {"error": "ring key required"}
        reason, prefix = body.get("reason"), body.get("device", "")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > MAX_REASON or not isinstance(prefix, str):
            return 400, {"error": "reason must contain 1 to 2000 characters; device must be a hash prefix"}
        matches = [device for device, _ in self.devices.identities() if device.startswith(prefix)]
        if len(matches) != 1:
            return 409, {"status": "device_required", "error": "select exactly one paired phone with --device hash-prefix"}
        if not self.control_slots.acquire(blocking=False):
            return 503, {"status": "busy"}
        ring = Ring(secrets.token_urlsafe(24), matches[0], reason.strip(), time.time() + self.timeout,
                    time.monotonic() + self.timeout)
        try:
            with self.lock:
                if any(other.device == ring.device for other in self.pending.values()):
                    return 409, {"status": "busy"}
                self.pending[ring.id] = ring
            try:
                publish(self.server, self.topic(ring.device), {"id": ring.id, "expires": ring.expires},
                        min(5.0, ring.remaining()))
            except (OSError, ValueError):
                # Exception text may contain the topic URL. It must never reach logs or the CLI.
                ring.finish("publish_failed")
            if not ring.done.wait(ring.remaining()):
                ring.finish("timeout")
            return 200, {"id": ring.id, "status": ring.state}
        finally:
            with self.lock:
                self.pending.pop(ring.id, None)
            self.control_slots.release()

    def routes(self) -> dict:
        return {"/v1/call/ring": self.control, "/v1/call/ring/register": self.register,
                "/v1/call/ring/pending": self.inspect, "/v1/call/ring/decline": self.decline}


def request_ring(config, reason: str, device: str = "") -> dict:
    body = {"reason": reason, "device": device}
    request = urllib.request.Request(local_listener(config.http_listen), json.dumps(body).encode(),
                                     {"Content-Type": "application/json",
                                      "X-Janet-Ring-Key": root_secret(config.ring_secret_file).decode()})
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}), pairing._NoRedirect())
    try:
        with direct.open(request, timeout=config.ring_timeout_s + 10) as response:
            return json.loads(response.read(pairing.MAX_BODY))
    except urllib.error.HTTPError as error:
        return json.loads(error.read(pairing.MAX_BODY))
