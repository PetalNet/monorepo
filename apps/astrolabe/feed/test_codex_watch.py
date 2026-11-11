import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).with_name("codex-watch")
ELI = "@lishaduck:beeper.com"


class FakeHomeserver(BaseHTTPRequestHandler):
    sent = []

    def do_PUT(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeHomeserver.sent.append(
            {"path": self.path, "auth": self.headers["Authorization"], "content": body})
        payload = json.dumps({"event_id": f"$e{len(FakeHomeserver.sent)}"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def snapshot(five=None, week=0.0, age_sec=0, awaiting=False):
    return {"five_hour_pct": five, "seven_day_pct": week, "scraped_at": int(time.time()) - age_sec,
            "snapshot_age_sec": 0, "awaiting": awaiting}


class CodexWatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeHomeserver)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeHomeserver.sent.clear()
        self.dir = tempfile.TemporaryDirectory()
        d = Path(self.dir.name)
        self.feed, self.state, creds = d / "usage.json", d / "state", d / "creds.json"
        creds.write_text(json.dumps({"access_token": "tok"}))
        self.env = {**os.environ, "CODEX_USAGE_PATH": str(self.feed),
                    "CODEX_WATCH_STATE": str(self.state), "CODEX_WATCH_MATRIX_CREDS": str(creds),
                    "CODEX_WATCH_HOMESERVER": f"http://127.0.0.1:{self.server.server_port}"}

    def tearDown(self):
        self.dir.cleanup()

    def run_watch(self, snap, state, *args):
        self.feed.write_text(json.dumps(snap))
        if state is not None:
            self.state.write_text(state + "\n")
        subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env,
                       capture_output=True, text=True, timeout=30, check=True)
        return [m["content"] for m in FakeHomeserver.sent]

    def stored_state(self):
        return self.state.read_text().strip() if self.state.exists() else None

    def test_out_to_ok_pings_with_a_real_mention(self):
        sent = self.run_watch(snapshot(five=20.0, week=40.0), "out")
        self.assertEqual(len(sent), 1)
        msg = sent[0]
        self.assertEqual(msg["body"], f"{ELI} Codex is back (60% left), you can turn Pullfrog on")
        self.assertEqual(msg["m.mentions"], {"user_ids": [ELI]})
        self.assertIn(f'href="https://matrix.to/#/{ELI}"', msg["formatted_body"])
        self.assertIn("%21jUddLoOYUBWXaHQuTP%3Amx.petalcat.dev", FakeHomeserver.sent[0]["path"])
        self.assertEqual(FakeHomeserver.sent[0]["auth"], "Bearer tok")
        self.assertEqual(self.stored_state(), "ok")

    def test_ok_to_out_pings(self):
        sent = self.run_watch(snapshot(five=91.5, week=10.0), "ok")
        self.assertEqual([m["body"] for m in sent],
                         [f"{ELI} Codex is under 15% (8% left), time to turn Pullfrog off"])
        self.assertEqual(self.stored_state(), "out")

    def test_ok_to_ok_is_silent(self):
        self.assertEqual(self.run_watch(snapshot(week=85.0), "ok"), [])
        self.assertEqual(self.stored_state(), "ok")

    def test_out_to_out_is_silent(self):
        self.assertEqual(self.run_watch(snapshot(week=86.0), "out"), [])
        self.assertEqual(self.stored_state(), "out")

    def test_missing_state_counts_as_out(self):
        self.assertEqual(self.run_watch(snapshot(week=99.0), None), [])
        sent = self.run_watch(snapshot(week=0.0), None)
        self.assertEqual([m["body"] for m in sent],
                         [f"{ELI} Codex is back (100% left), you can turn Pullfrog on"])

    def test_stale_reading_is_a_no_op(self):
        self.assertEqual(self.run_watch(snapshot(week=99.0, age_sec=2 * 3600 + 60), "ok"), [])
        self.assertEqual(self.stored_state(), "ok")

    def test_old_data_in_a_fresh_snapshot_is_stale(self):
        snap = {**snapshot(week=99.0), "snapshot_age_sec": 3 * 3600}
        self.assertEqual(self.run_watch(snap, "ok"), [])
        self.assertEqual(self.stored_state(), "ok")

    def test_awaiting_reading_is_a_no_op(self):
        self.assertEqual(self.run_watch(snapshot(week=0.0, awaiting=True), "out"), [])
        self.assertEqual(self.stored_state(), "out")

    def test_dry_run_prints_and_keeps_state(self):
        self.feed.write_text(json.dumps(snapshot(week=0.0)))
        self.state.write_text("out\n")
        out = subprocess.run([sys.executable, str(SCRIPT), "--dry-run"], env=self.env,
                             capture_output=True, text=True, timeout=30, check=True).stdout
        self.assertEqual(out, f"{ELI} Codex is back (100% left), you can turn Pullfrog on\n")
        self.assertEqual(FakeHomeserver.sent, [])
        self.assertEqual(self.stored_state(), "out")


if __name__ == "__main__":
    unittest.main()
