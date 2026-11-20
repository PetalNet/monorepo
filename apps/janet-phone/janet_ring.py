#!/usr/bin/env python3
"""Ring a paired phone through the running bridge. Uses only Python's standard library."""

import argparse
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tomllib
from types import SimpleNamespace

import ringing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reason")
    parser.add_argument("--device", default="", help="paired device hash prefix, required when more than one is paired")
    parser.add_argument("--config", type=Path, default=Path(os.environ.get(
        "JANET_PHONE_CONFIG", Path.home() / ".config/janet-phone/phone.toml")))
    parser.add_argument("--ssh", default=os.environ.get("JANET_RING_SSH", ""),
                        help="SSH host with janet-ring installed beside the bridge")
    parser.add_argument("--container", default=os.environ.get("JANET_RING_CONTAINER", ""),
                        help="Docker bridge container, on the SSH host when --ssh is set")
    args = parser.parse_args()
    if args.ssh or args.container:
        if args.ssh.startswith("-") or args.container.startswith("-"):
            parser.error("SSH host and container name must not start with '-'")
        if args.container:
            command = ["docker", "exec", "--", args.container, "/opt/venv/bin/python", "/app/janet_phone.py",
                       "--config", str(args.config), "--ring=" + args.reason]
            if args.device:
                command += ["--device", args.device]
        else:
            command = ["janet-ring", "--config", str(args.config), "--device", args.device, "--", args.reason]
        if args.ssh:
            command = ["ssh", "-o", "BatchMode=yes", "--", args.ssh, shlex.join(command)]
        try:
            return subprocess.run(command, check=False).returncode
        except OSError:
            print("janet-ring: could not start the bridge command", file=sys.stderr)
            return 2
    try:
        values = tomllib.loads(args.config.read_text())
        config = SimpleNamespace(http_listen=values.get("http_listen", ""),
                                 ring_secret_file=values.get("ring_secret_file", ""),
                                 ring_timeout_s=values.get("ring_timeout_s", 45))
        result = ringing.request_ring(config, args.reason, args.device)
        if not isinstance(result, dict):
            raise ValueError("invalid bridge response")
        status = result.get("status", "failed")
        print(f"janet-ring: {status}")
        if error := result.get("error"):
            print(error, file=sys.stderr)
        return 0 if status == "audio_connected" else 1
    except (OSError, ValueError, TypeError):
        # Transport errors can include the authenticated URL or the root key's file path.
        print("janet-ring: could not reach the bridge or read its ring configuration", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
