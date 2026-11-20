import json
import os
import shutil
import tempfile
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from janet_voice_head import lab_tools


class LabToolsTest(unittest.TestCase):
    def test_only_fixed_tools_with_empty_arguments(self):
        for name, args in [("vault", {}), ("builders", {"command": "restart"}), ("health", {"path": "/secrets"}), ("pull_requests", {"repo": "other/repo"}), ("objectives", {"path": "/other"}), ("usage", {"command": "cat"}), ("usage", {"args": ["check"]}), ("usage", {"path": "/other"}), ("usage", {"provider": "other"})]:
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

    def test_malformed_source_output_is_unavailable_not_a_server_crash(self):
        with patch.object(lab_tools, "run", return_value='[{"unit":"route-a.service"}]'):
            result = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "builders"}})
        self.assertTrue(result["result"]["isError"])

    def test_run_deadline_and_output_limit(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            lab_tools.run([sys.executable, "-c", "import time; time.sleep(10)"], started + 0.1)
        self.assertLess(time.monotonic() - started, 1)
        with self.assertRaises(ValueError):
            lab_tools.run([sys.executable, "-c", "print('x' * 1000000)"], time.monotonic() + 3)

    def test_objectives_reuse_the_bounded_index_without_hook_instructions(self):
        payload = {"hookSpecificOutput": {"additionalContext": "OPEN OBJECTIVES: read the file\n- Ship widget | active | next: review\nPromise ledger: 2 open"}}
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            shared = Path(tmp) / ".claude/shared"
            shared.mkdir(parents=True)
            (shared / "open-objectives.md").write_text("- **Ship widget**")
            with patch.object(lab_tools, "run", return_value=json.dumps(payload)) as run:
                text = lab_tools.lookup("objectives", {})
            self.assertEqual(run.call_args.args[0], [str(Path(tmp) / ".local/state/objectives-index-pkg/bin/sessionstart-objectives")])
        self.assertIn("Ship widget", text)
        self.assertNotIn("read the file", text)
        self.assertNotIn("Promise ledger", text)

    def test_objectives_include_current_heading_sections_and_latest_edits(self):
        payload = {"hookSpecificOutput": {"additionalContext": "- Older widget | ACTIVE"}}
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            shared = Path(tmp) / ".claude/shared"
            shared.mkdir(parents=True)
            ledger = shared / "open-objectives.md"
            ledger.write_text('- **Older widget** · state: ACTIVE\n## envgen build | ACTIVE\n- Next: collect proofs\n')
            with patch.object(lab_tools, "run", return_value=json.dumps(payload)):
                text = lab_tools.lookup("objectives", {})
                self.assertIn("envgen build | ACTIVE", text)
                self.assertIn("collect proofs", text)
                self.assertIn("Older widget", text)
                ledger.write_text(ledger.read_text().replace("collect proofs", "review new build"))
                self.assertIn("review new build", lab_tools.lookup("objectives", {}))

    def test_usage_is_listed_read_only_and_reports_both_provider_numbers(self):
        listed = lab_tools.respond({"id": 1, "method": "tools/list"})["result"]["tools"]
        self.assertIn("usage", {tool["name"] for tool in listed})
        tool = next(tool for tool in listed if tool["name"] == "usage")
        self.assertTrue(tool["annotations"]["readOnlyHint"])
        self.assertFalse(tool["inputSchema"]["additionalProperties"])
        reports = [
            {"service": "claude", "status": "ok", "limits": [{"label": "Claude 5h", "usedPct": 23, "resetLabel": "tomorrow"}], "summary": "5h 23%"},
            {"service": "codex", "status": "ok", "limits": [{"label": "Codex 7d", "usedPct": 81}], "summary": "7d 81%"},
        ]
        with patch.object(lab_tools, "run", return_value=json.dumps(reports)) as run:
            text = lab_tools.lookup("usage", {})
        self.assertIn("Claude 5h: 23%", text)
        self.assertIn("Codex 7d: 81%", text)
        self.assertIn("tomorrow", text)
        self.assertIn("snapshot", text.lower())
        self.assertEqual(run.call_count, 1)

    def test_usage_missing_provider_is_unavailable_without_hiding_the_other(self):
        reports = [
            {"service": "claude", "status": "error", "limits": [], "summary": "private diagnostic"},
            {"service": "codex", "status": "ok", "limits": [{"label": "Codex 5h", "usedPct": 0}], "summary": "5h 0%"},
        ]
        with patch.object(lab_tools, "run", return_value=json.dumps(reports)):
            text = lab_tools.lookup("usage", {})
        self.assertIn("Claude: unavailable", text)
        self.assertIn("Codex 5h: 0%", text)
        self.assertNotIn("private diagnostic", text)

    def test_missing_sources_are_unavailable_without_details(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            ledger = Path(tmp) / ".claude/shared/open-objectives.md"
            ledger.parent.mkdir(parents=True)
            ledger.write_text("## envgen | ACTIVE\n")
            for name in ("objectives", "usage"):
                for error in (FileNotFoundError("private source path"), TimeoutError("private source path"), ValueError("private source path")):
                    with self.subTest(name=name, error=type(error)), patch.object(lab_tools, "run", side_effect=error) as run:
                        response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": name}})
                        self.assertTrue(response["result"]["isError"])
                        self.assertNotIn("private source path", json.dumps(response))
                        run.assert_called_once()

    def test_objectives_missing_ledger_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)), patch.object(lab_tools, "run") as run:
            response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "objectives"}})
            self.assertTrue(response["result"]["isError"])
            run.assert_not_called()

    def test_objectives_missing_index_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            ledger = Path(tmp) / ".claude/shared/open-objectives.md"
            ledger.parent.mkdir(parents=True)
            ledger.write_text("## envgen | ACTIVE\n")
            response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "objectives"}})
            self.assertTrue(response["result"]["isError"])

    def test_usage_malformed_reports_are_unavailable(self):
        payloads = ["not JSON", "{}", '[{"service":"codex","status":"ok","limits":null}]']
        for pct in (None, True, "23", -1, float("inf"), float("nan"), 10**400):
            payloads.append(json.dumps([{"service": "claude", "status": "ok", "limits": [{"label": "Claude 5h", "usedPct": pct}]}]))
        for payload in payloads:
            with self.subTest(payload=payload[:80]), patch.object(lab_tools, "run", return_value=payload):
                response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "usage"}})
                self.assertTrue(response["result"]["isError"])

    def test_usage_without_numbers_does_not_claim_zero_or_disclose_raw_data(self):
        for reports in ([], [{"service": "codex", "status": "signed-out", "summary": "private diagnostic", "limits": []}],
                        [{"service": "claude", "status": "ok", "summary": "signed in", "limits": []}]):
            with self.subTest(reports=reports), patch.object(lab_tools, "run", return_value=json.dumps(reports)):
                text = lab_tools.lookup("usage", {})
                self.assertIn("Claude: unavailable", text)
                self.assertIn("Codex: unavailable", text)
                self.assertNotIn("0%", text)
                self.assertNotIn("private diagnostic", text)

    def test_usage_retains_staleness_warning(self):
        reports = [{"service": "claude", "status": "ok", "summary": "5h 23% · stale 45m", "limits": [{"label": "Claude 5h", "usedPct": 23}]}]
        with patch.object(lab_tools, "run", return_value=json.dumps(reports)):
            self.assertIn("Claude: stale 45m", lab_tools.lookup("usage", {}))

    @unittest.skipUnless(shutil.which("node"), "Quota parser requires Node")
    def test_real_quota_parser_reads_stale_snapshot_without_running_refresh_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            shared, commands = home / ".claude/shared", home / ".claude/bin"
            sessions = home / ".codex/sessions"
            for directory in (shared, commands, sessions):
                directory.mkdir(parents=True)
            snapshot = shared / "janet-usage.json"
            snapshot.write_text(json.dumps({"five_hour_pct": 23, "seven_day_pct": 41, "scraped_at": time.time() - 3600}))
            before = snapshot.read_bytes()
            usage = commands / "usage"
            usage.write_text(f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(home / 'refreshed')!r}).touch()\n")
            usage.chmod(0o755)
            codex = commands / "codex"
            codex.write_text(f"#!{sys.executable}\nimport sys\nassert sys.argv[1:] == ['login', 'status']\nprint('Logged in using ChatGPT')\n")
            codex.chmod(0o755)
            (sessions / "rollout.jsonl").write_text(json.dumps({"rate_limits": {"primary": {"used_percent": 17}, "secondary": {"used_percent": 63}}}) + "\n")
            with patch.dict(os.environ, {"HOME": tmp, "PATH": str(commands) + os.pathsep + os.environ["PATH"]}):
                text = lab_tools.lookup("usage", {})
            self.assertIn("Claude 5h: 23%", text)
            self.assertIn("Codex 5h: 17%", text)
            self.assertIn("Codex 7d: 63%", text)
            self.assertRegex(text, r"Claude: stale \d+m")
            self.assertEqual(snapshot.read_bytes(), before)
            self.assertFalse((home / "refreshed").exists())

    def test_objectives_sections_have_a_byte_cap_and_report_omissions(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            ledger = Path(tmp) / ".claude/shared/open-objectives.md"
            ledger.parent.mkdir(parents=True)
            ledger.write_text("\n".join(f"## Objective {n} {'🌳' * 100} | ACTIVE" for n in range(200)))
            payload = {"hookSpecificOutput": {"additionalContext": "- Older widget | ACTIVE"}}
            with patch.object(lab_tools, "run", return_value=json.dumps(payload)):
                text = lab_tools.lookup("objectives", {})
            self.assertLessEqual(len(text.encode()), lab_tools.MAX_OUTPUT)
            self.assertIn("Objective 199", text)
            self.assertIn("More objectives remain", text)

    def test_objectives_reject_nonregular_and_oversized_input_without_running_index(self):
        for kind in ("directory", "fifo", "oversized"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
                ledger = Path(tmp) / ".claude/shared/open-objectives.md"
                ledger.parent.mkdir(parents=True)
                if kind == "directory":
                    ledger.mkdir()
                elif kind == "fifo":
                    os.mkfifo(ledger)
                else:
                    ledger.write_bytes(b"x" * (lab_tools.MAX_OBJECTIVES_INPUT + 1))
                with patch.object(lab_tools, "run") as run:
                    response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "objectives"}})
                self.assertTrue(response["result"]["isError"])
                run.assert_not_called()

    def test_objectives_use_checked_inode_for_sections_and_index_after_replacement(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            ledger = Path(tmp) / ".claude/shared/open-objectives.md"
            ledger.parent.mkdir(parents=True)
            ledger.write_text("## Approved objective | ACTIVE\n")
            original_fstat = os.fstat
            def replace_path(fd):
                info = original_fstat(fd)
                ledger.unlink()
                ledger.write_text("## Replacement marker\n")
                return info
            def index(argv, deadline, *, source_fd):
                self.assertIn(b"Approved objective", os.read(source_fd, 4096))
                return json.dumps({"hookSpecificOutput": {"additionalContext": ""}})
            with patch.object(lab_tools.os, "fstat", side_effect=replace_path), patch.object(lab_tools, "run", side_effect=index):
                text = lab_tools.lookup("objectives", {})
            self.assertIn("Approved objective", text)
            self.assertNotIn("Replacement marker", text)

    def test_usage_stdio_uses_fixed_reader_and_sanitized_environment(self):
        reports = [{"service": "claude", "status": "ok", "limits": [{"label": "Claude 5h", "usedPct": 23}]},
                   {"service": "codex", "status": "ok", "limits": [{"label": "Codex 7d", "usedPct": 81}]}]
        with tempfile.TemporaryDirectory() as tmp:
            node = Path(tmp) / "node"
            node.write_text(f"#!{sys.executable}\nimport os, sys\n"
                            "assert sys.argv[1:4] == ['--no-warnings', '--input-type=module', '--eval']\n"
                            "assert 'parseClaudeUsageJson' in sys.argv[4] and 'readCodex(config, deps)' in sys.argv[4]\n"
                            "assert 'readAllServices' not in sys.argv[4]\n"
                            "assert len(sys.argv) == 6 and sys.argv[5].endswith('/packages/harness-hooks/src/quota-sources.ts')\n"
                            "assert not any(k in os.environ for k in ('QUOTA_CODEX_CMD', 'QUOTA_CLAUDE_USAGE_CMD', 'NODE_OPTIONS', 'OBJECTIVES_LEDGER'))\n"
                            f"print({json.dumps(reports)!r})\n")
            node.chmod(0o700)
            env = dict(os.environ, PATH=tmp, QUOTA_CODEX_CMD="/other", QUOTA_CLAUDE_USAGE_CMD="/other", NODE_OPTIONS="--inspect", OBJECTIVES_LEDGER="/other")
            request = {"id": 1, "method": "tools/call", "params": {"name": "usage", "arguments": {}}}
            proc = subprocess.run([sys.executable, "-I", lab_tools.__file__], input=json.dumps(request) + "\n", capture_output=True, text=True, env=env, timeout=5, check=True)
            response = json.loads(proc.stdout)["result"]
            self.assertFalse(response["isError"])
            self.assertIn("Claude 5h: 23%", response["content"][0]["text"])
            self.assertIn("Codex 7d: 81%", response["content"][0]["text"])

    def test_usage_deadline_and_pipe_output_cap(self):
        for code in ("import time; time.sleep(10)", "print('x' * 1000000)"):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as tmp:
                node = Path(tmp) / "node"
                node.write_text(f"#!{sys.executable}\n{code}\n")
                node.chmod(0o700)
                with patch.dict(os.environ, {"PATH": tmp}), patch.object(lab_tools, "TIMEOUT_S", 0.1):
                    response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "usage"}})
                self.assertTrue(response["result"]["isError"])

    def test_aggregate_output_cap(self):
        with patch.object(lab_tools, "lookup", return_value="🌳" * lab_tools.MAX_OUTPUT):
            response = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "health"}})
        self.assertTrue(response["result"]["isError"])

    def test_objectives_refuse_symlinks_to_other_files(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "home", return_value=Path(tmp)):
            shared = Path(tmp) / ".claude/shared"
            shared.mkdir(parents=True)
            (Path(tmp) / "credential").write_text("- **Secret-shaped objective**")
            (shared / "open-objectives.md").symlink_to(Path(tmp) / "credential")
            with self.assertRaises(OSError), patch.object(lab_tools, "run") as run:
                lab_tools.lookup("objectives", {})
            run.assert_not_called()

    def test_index_input_is_the_open_source_even_after_path_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "objectives"
            path.write_text("approved objectives")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                path.unlink()
                path.write_text("replacement secret")
                result = lab_tools.run([sys.executable, "-c", "import os; print(open(os.environ['OBJECTIVES_LEDGER']).read())"], time.monotonic() + 3, source_fd=fd)
                self.assertEqual(result, "approved objectives")
            finally:
                os.close(fd)

    def test_stdio_transport_lists_only_allowlist_and_returns_bounded_result(self):
        requests = [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "builders", "arguments": {}}}]
        proc = subprocess.run([sys.executable, "-I", lab_tools.__file__], input="\n".join(map(json.dumps, requests)) + "\n", capture_output=True, text=True, timeout=5, check=True)
        listed, called = map(json.loads, proc.stdout.splitlines())
        self.assertEqual({tool["name"] for tool in listed["result"]["tools"]}, set(lab_tools.DESCRIPTIONS))
        self.assertIsInstance(called["result"]["content"][0]["text"], str)
