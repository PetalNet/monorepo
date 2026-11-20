#!/usr/bin/env python3
"""Extend Shawn's existing account for the dedicated, unencrypted vulns room."""

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path


HOMESERVER = "https://mx.petalcat.dev/_matrix/client/v3"


def post(payload: dict, room: str, account: dict, request=None) -> dict:
    if payload["room_id"] != room or not room.startswith("!"):
        raise ValueError("destination is not the configured vulns room")
    if account["user_id"] != "@shawn:mx.petalcat.dev":
        raise ValueError("poster requires the existing Shawn identity")
    if not re.fullmatch(r"[a-f0-9]{64}", payload["transaction_id"]):
        raise ValueError("transaction_id must be a SHA-256 digest")
    if not isinstance(payload["body"], str) or not 0 < len(payload["body"]) <= 16000:
        raise ValueError("message length must be 1..16000 characters")

    def api(path, method="GET", body=None):
        req = urllib.request.Request(
            HOMESERVER + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + account["access_token"],
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)

    request = request or api
    if request("/account/whoami")["user_id"] != account["user_id"]:
        raise ValueError("Matrix token identity differs from Shawn account")
    encoded = urllib.parse.quote(room, safe="")
    state = request(f"/rooms/{encoded}/state")
    if any(event["type"] == "m.room.encryption" for event in state):
        raise ValueError("encrypted rooms must use the existing supervised encryption sender")
    return request(f"/rooms/{encoded}/send/m.room.message/{payload['transaction_id']}", "PUT",
                   {"msgtype": "m.notice", "body": payload["body"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--room", required=True)
    parser.add_argument("--account-file", type=Path,
                        default=Path("/home/docker/.claude/shared/shawn-account.json"))
    options = parser.parse_args()
    try:
        account = json.loads(options.account_file.read_text())
        payload = json.loads(sys.stdin.read(65537))
        print(json.dumps(post(payload, options.room, account)))
    except Exception as error:
        # Transport exceptions can contain request details; keep credentials out of logs.
        print(f"Shawn post failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
