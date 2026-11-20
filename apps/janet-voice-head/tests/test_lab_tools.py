import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from janet_voice_head import lab_tools


class LabToolsTest(unittest.TestCase):
    def test_only_fixed_tools_with_empty_arguments(self):
        for name, args in [("vault", {}), ("builders", {"command": "restart"}), ("health", {"path": "/secrets"}), ("pull_requests", {"repo": "other/repo"})]:
            with self.subTest(name=name), patch.object(lab_tools, "run") as run:
                result = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
                self.assertTrue(result["result"]["isError"])
                run.assert_not_called()

    def test_builders_project_state_without_descriptions_or_commands(self):
        with patch.object(lab_tools, "run", return_value=json.dumps([{"unit": "route-a.service", "active": "active", "sub": "running", "description": "secret command"}])) as run:
            self.assertEqual(lab_tools.lookup("builders", {}), "route-a.service: active running")
            self.assertIn("route-*", run.call_args.args[0])

    def test_errors_do_not_disclose_command_stderr(self):
        with patch.object(lab_tools, "lookup", side_effect=OSError("credential-value")):
            response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "builders"}})
            self.assertNotIn("credential-value", json.dumps(response))

    def test_run_deadline_and_output_limit(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            lab_tools.run([sys.executable, "-c", "import time; time.sleep(10)"], started + 0.1)
        self.assertLess(time.monotonic() - started, 1)
        with self.assertRaises(ValueError):
            lab_tools.run([sys.executable, "-c", "print('x' * 1000000)"], time.monotonic() + 3)

    def test_objectives_symlink_cannot_point_at_credentials(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            shared = Path(tmp) / ".claude/shared"
            shared.mkdir(parents=True)
            (Path(tmp) / "credential").write_text("secret")
            (shared / "open-objectives.md").symlink_to(Path(tmp) / "credential")
            with self.assertRaises(OSError):
                lab_tools.lookup("objectives", {})

    def test_stdio_transport_lists_only_allowlist_and_returns_bounded_result(self):
        requests = [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "builders", "arguments": {}}}]
        proc = subprocess.run([sys.executable, "-I", lab_tools.__file__], input="\n".join(map(json.dumps, requests)) + "\n", capture_output=True, text=True, timeout=5, check=True)
        listed, called = map(json.loads, proc.stdout.splitlines())
        self.assertEqual({tool["name"] for tool in listed["result"]["tools"]}, set(lab_tools.DESCRIPTIONS))
        self.assertIsInstance(called["result"]["content"][0]["text"], str)
