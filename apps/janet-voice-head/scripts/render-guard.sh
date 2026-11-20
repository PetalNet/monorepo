#!/usr/bin/env bash
set -eu
exec python3 - <<'PY'
import json
import math
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

try:
    token_file = Path(os.environ.get("VOICE_HEAD_TOKEN_FILE", str(Path.home() / ".hermes-janet/secrets/voice-head-token")))
    url = os.environ.get("VOICE_HEAD_URL", "http://127.0.0.1:8791").rstrip("/")
    request = urllib.request.Request(url + "/v1/calls", headers={
        "Authorization": "Bearer " + token_file.read_text().strip(),
    })
    with urllib.request.urlopen(request, timeout=3) as response:
        calls = json.load(response)["active_calls"]
    if type(calls) is not int or calls < 0:
        raise ValueError("invalid call status")
    if calls:
        print(f"active_calls={calls}; rendering paused")
        sys.exit(1)
    result = subprocess.run([
        "ssh", "-oBatchMode=yes", "-oConnectTimeout=2",
        os.environ.get("VOICE_TTS_SSH", "Parker@10.10.10.152"),
        "curl.exe --fail --silent --max-time 2 http://127.0.0.1:8735/status",
    ], capture_output=True, text=True, timeout=5, check=True)
    status = json.loads(result.stdout)
    loaded, busy, queued = status["loaded"], status["busy"], status["queue_depth"]
    free = float(status["free_vram_gb"])
    if type(loaded) is not bool or type(busy) is not bool or type(queued) is not int or queued < 0 or not math.isfinite(free):
        raise ValueError("invalid TTS status")
    print(f"active_calls=0 tts_loaded={loaded} tts_busy={busy} queue_depth={queued} free_vram_gb={free}")
    sys.exit(0 if not loaded and not busy and queued == 0 and free >= 5 else 1)
except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
    print(f"voice status unavailable; rendering paused ({type(error).__name__})", file=sys.stderr)
    sys.exit(1)
PY
