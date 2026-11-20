import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


GUARD = Path(__file__).resolve().parents[1] / "scripts/render-guard.sh"


class RenderGuardTest(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        token = root / "token"
        token.write_text("test-token")
        self.calls = {"active_calls": 0}
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                test.assertEqual(self.path, "/v1/calls")
                test.assertEqual(self.headers.get("Authorization"), "Bearer test-token")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(test.calls).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        ssh = root / "ssh"
        ssh.write_text(f'#!{sys.executable}\nimport os\nprint(os.environ["FAKE_TTS_STATUS"])\n')
        ssh.chmod(0o755)
        self.env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                    "VOICE_HEAD_URL": f"http://127.0.0.1:{server.server_port}",
                    "VOICE_HEAD_TOKEN_FILE": str(token)}

    def guard(self, **status):
        tts = {"loaded": False, "busy": False, "queue_depth": 0, "free_vram_gb": 5.1, **status}
        return subprocess.run(["bash", str(GUARD)], capture_output=True, text=True, timeout=5,
                              env={**self.env, "FAKE_TTS_STATUS": json.dumps(tts)})

    def test_idle_unloaded_gpu_with_room_permits_rendering(self):
        self.assertEqual(self.guard().returncode, 0)

    def test_live_call_blocks_rendering_even_with_an_unloaded_gpu(self):
        self.calls = {"active_calls": 1}
        result = self.guard()
        self.assertEqual(result.returncode, 1)
        self.assertIn("active_calls=1", result.stdout)

    def test_busy_loaded_queued_or_crowded_gpu_blocks_rendering(self):
        for status in ({"loaded": True}, {"busy": True}, {"queue_depth": 1}, {"free_vram_gb": 4.99}):
            with self.subTest(status=status):
                self.assertEqual(self.guard(**status).returncode, 1)

    def test_invalid_vram_status_blocks_rendering(self):
        for value in (float("inf"), float("nan"), "Infinity", None, "unknown"):
            with self.subTest(value=value):
                self.assertEqual(self.guard(free_vram_gb=value).returncode, 1)

    def test_invalid_call_status_or_unavailable_head_blocks_rendering(self):
        for calls in ({}, {"active_calls": False}, {"active_calls": -1}):
            with self.subTest(calls=calls):
                self.calls = calls
                self.assertEqual(self.guard().returncode, 1)
        self.env["VOICE_HEAD_URL"] = "http://127.0.0.1:1"
        self.assertEqual(self.guard().returncode, 1)
