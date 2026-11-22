"""Idempotent enqueue into the existing lab sender's durable outbox and sent archive."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time


def enqueue(outbox, key, message):
    outbox.mkdir(parents=True, exist_ok=True)
    name = "codex-current-" + hashlib.sha256(key.encode()).hexdigest() + ".json"
    queued = outbox / name
    with (outbox / ".codex-alert.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # The sender atomically moves queued files to sent; check in that order.
        if queued.exists() or (outbox / "sent" / name).exists():
            return
        if (outbox / "failed" / name).exists():
            raise RuntimeError("Codex alert is in the sender's failed queue")
        descriptor, temporary = tempfile.mkstemp(prefix=".codex-alert-", dir=outbox)
        try:
            with os.fdopen(descriptor, "w") as stream:
                json.dump({"sender": "shawn", "body": "[info] codex-current: " + message,
                           "ts": time.time(), "key": key}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, queued)
            directory = os.open(outbox, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    enqueue(Path.home() / ".claude/shared/system-outbox", sys.argv[1], sys.argv[2])
