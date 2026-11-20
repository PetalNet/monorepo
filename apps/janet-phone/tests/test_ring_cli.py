"""Exercise the installed command, including its exit codes and SSH argument boundary."""

import http.server
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import threading
import unittest


APP = Path(__file__).resolve().parents[1]


class InstalledRingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.command = root / "bin with spaces/janet-ring"
        subprocess.run([str(APP / "install-ring.sh"), "--prefix", str(root / "installed files"),
                        "--bin-dir", str(self.command.parent)], check=True, capture_output=True)
        self.root = root
        self.key = "test-ring-key-" + "x" * 32
        self.status = "audio_connected"
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append((self.path, self.headers["X-Janet-Ring-Key"], body))
                payload = json.dumps({"status": owner.status}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        key = root / "key"
        key.write_text(self.key)
        self.config = root / "phone.toml"
        self.config.write_text(f'http_listen = "127.0.0.1:{server.server_port}"\n'
                               f'ring_secret_file = "{key}"\nring_timeout_s = 1\n')
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("JANET_RING_SSH", "JANET_RING_CONTAINER", "JANET_PHONE_CONFIG")}

    def run_command(self, *args):
        return subprocess.run([str(self.command), "--config", str(self.config), *args],
                              capture_output=True, text=True, env=self.env, timeout=10)

    def test_installed_command_reports_audio_decline_timeout_and_failures(self):
        for status in ("audio_connected", "declined", "timeout", "busy", "publish_failed", "gateway_failed", "audio_failed"):
            with self.subTest(status=status):
                self.status = status
                result = self.run_command("--device", "abcd", "An urgent test reason")
                self.assertEqual(0 if status == "audio_connected" else 1, result.returncode, result.stderr)
                self.assertIn(status, result.stdout)
                self.assertNotIn(self.key, result.stdout + result.stderr)
                self.assertEqual(("/v1/call/ring", self.key, {"reason": "An urgent test reason", "device": "abcd"}),
                                 self.requests[-1])

    def test_missing_configuration_is_an_error(self):
        self.config.unlink()
        result = self.run_command("Test")
        self.assertEqual(2, result.returncode)
        self.assertIn("configuration", result.stderr)

    def test_installer_remembers_the_selected_phone(self):
        subprocess.run([str(APP / "install-ring.sh"), "--prefix", str(self.root / "installed files"),
                        "--bin-dir", str(self.command.parent), "--device", "abcd"],
                       check=True, capture_output=True)
        result = self.run_command("A saved phone selection")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("abcd", self.requests[-1][2]["device"])

    def test_refuses_to_send_root_key_to_non_loopback(self):
        self.config.write_text(self.config.read_text().replace("127.0.0.1", "192.0.2.1"))
        result = self.run_command("Test")
        self.assertEqual(2, result.returncode)
        self.assertEqual([], self.requests)

    def test_ssh_preserves_reason_as_one_argument(self):
        record = self.root / "ssh.json"
        fake = self.root / "ssh"
        fake.write_text('#!/usr/bin/env python3\nimport json,sys\n'
                        f'open({str(record)!r}, "w").write(json.dumps(sys.argv[1:]))\n')
        fake.chmod(0o755)
        self.env["PATH"] = str(self.root) + os.pathsep + self.env["PATH"]
        reason = "Urgent 'test'; $(touch /tmp/never-execute-janet-ring)"
        result = self.run_command("--ssh", "lab-host", "--container", "janet-phone", reason)
        self.assertEqual(0, result.returncode, result.stderr)
        argv = json.loads(record.read_text())
        self.assertEqual(["-o", "BatchMode=yes", "--", "lab-host"], argv[:-1])
        remote = shlex.split(argv[-1])
        self.assertEqual("--ring=" + reason, remote[-1])
        self.assertEqual(["docker", "exec", "--", "janet-phone"], remote[:4])


if __name__ == "__main__":
    unittest.main()
