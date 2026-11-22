"""Submit a capture in memory to the isolated bot's local provisioning API."""

import json
from pathlib import Path
import sys
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from import_curl import CaptureError, MAX_CAPTURE, parse_capture

BOT = "@parkerbott:beeper.com"
ACCOUNT = "petalcat27@gmail.com"
CONFIG = Path("/root/.local/share/bbctl/prod/sh-gchat/config.yaml")


def submit(capture, config, opener=urlopen):
    cookies = parse_capture(capture)
    address = config["appservice"]["address"]
    target = urlsplit(address)
    if target.scheme != "http" or target.hostname != "127.29.3.20":
        raise CaptureError("Expected the isolated bot's loopback provisioning API.")
    provisioning = config["bridge"]["provisioning"]
    secret = provisioning["shared_secret"]
    if not secret or secret == "disable":
        raise CaptureError("The bot provisioning API is disabled.")
    base = address.rstrip("/") + provisioning["prefix"].rstrip("/")
    query = "?" + urlencode({"user_id": BOT})

    def request(path, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        req = Request(base + path + query, data=body, headers={
            "Authorization": "Bearer " + secret,
            "Content-Type": "application/json",
        })
        with opener(req, timeout=45) as response:
            return json.load(response)

    existing = request("/v1/whoami").get("googlechat")
    if existing:
        if existing.get("email", "").lower() != ACCOUNT:
            raise CaptureError("A different account is already logged in. Stop for operator review.")
        return {"account_verified": True, "login_attempted": False,
                "connected": bool(existing.get("connected"))}
    result = request("/v1/login", {"cookies": cookies.bridge_fields()})
    if result.get("status") != "success":
        raise CaptureError("Google rejected the capture. Stop; request a fresh capture without retrying.")
    if result.get("email", "").lower() != ACCOUNT:
        request("/v1/logout", {})
        raise CaptureError("Wrong Google account. The bot login was removed; stop for operator review.")
    return {"account_verified": True, "login_attempted": True,
            "connected": bool((request("/v1/whoami").get("googlechat") or {}).get("connected"))}


def main():
    if len(sys.argv) != 1 or sys.stdin.isatty():
        print("Pipe the private capture to the isolated bot's submit_capture.py.", file=sys.stderr)
        return 2
    try:
        raw = sys.stdin.buffer.read(MAX_CAPTURE + 1)
        if len(raw) > MAX_CAPTURE:
            raise CaptureError("Capture exceeds the vault-drop limit.")
        import yaml
        config = yaml.safe_load(CONFIG.read_text())
        result = submit(raw.decode("utf-8"), config)
    except CaptureError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        print("Capture submission failed. Stop for operator review; no automatic retry.", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
