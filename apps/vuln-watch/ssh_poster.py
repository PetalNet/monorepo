#!/usr/bin/env python3
"""Run the Shawn adapter on .14 without copying credentials or encryption stores."""

import argparse
import shlex
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--room", required=True)
    parser.add_argument("--host", default="docker@10.10.10.14")
    options = parser.parse_args()
    source = Path(__file__).with_name("shawn_poster.py").read_text()
    command = "python3 -c " + shlex.quote(source) + " --room " + shlex.quote(options.room)
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", options.host, command],
                            input=sys.stdin.buffer.read(65537), capture_output=True, timeout=55)
    if result.returncode:
        print("remote Shawn adapter failed", file=sys.stderr)
        sys.exit(1)
    sys.stdout.buffer.write(result.stdout)


if __name__ == "__main__":
    main()
