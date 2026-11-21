import io
import json
import unittest
from unittest.mock import patch

from janet_voice_head import lab_tools, prompts


def event(text, sender="@parker:test", ts=1795244845000, **extra):
    return {"type": "m.room.message", "body": text, "sender": sender, "ts": ts, **extra}


class MatrixRecentTest(unittest.TestCase):
    def history(self, events, limit=10):
        data = json.dumps({"result": json.dumps({"events": events})}).encode()
        with patch.object(lab_tools, "urlopen", return_value=io.BytesIO(data)) as fetch, \
                patch.object(type(lab_tools.HUB_TOKEN_FILE), "read_text", return_value="fixture-token"):
            text = lab_tools.matrix_recent(limit)
        self.assertEqual(json.loads(fetch.call_args.args[0].data), {"name": "history", "args": {"room": "janet-dm", "limit": 50}})
        self.assertLessEqual(len(text.encode()), lab_tools.MAX_OUTPUT)
        return json.loads(text)

    def test_both_sides_in_chronological_order_with_utc_timestamps(self):
        result = self.history([event("Janet reply", "@janet:test", 1795244846000),
                               {"type": "m.reaction"}, event("Parker question"), event("older")], limit=2)
        self.assertEqual([m["text"] for m in result["messages"]], ["Parker question", "Janet reply"])
        self.assertEqual([m["sender"] for m in result["messages"]], ["@parker:test", "@janet:test"])
        self.assertEqual(result["messages"][0]["at"], "2026-11-21T07:07:25+00:00")
        self.assertFalse(result["truncated"])

    def test_output_cap_keeps_newest_and_reports_cuts(self):
        for body in ("🌳" * 1700, "\x00" * 1700, '"\\' * 1700):
            with self.subTest(body=body[:4]):
                result = self.history([event(f"{n}:" + body) for n in range(8)], 50)
                self.assertTrue(result["truncated"])
                self.assertTrue(result["messages"][-1]["text"].startswith("0:"))
                self.assertTrue(all(m["truncated"] for m in result["messages"]))
                self.assertLess(len(result["messages"]), 8)

    def test_empty_window_is_explicit_and_does_not_fabricate_context(self):
        result = self.history([])
        self.assertEqual(result["messages"], [])
        self.assertEqual(result["event_window"], 0)

    def test_only_count_is_accepted_before_any_io(self):
        for args in ({"limit": 0}, {"limit": 51}, {"limit": True}, {"limit": 1.5}, {"limit": "3"},
                     {"room": "elsewhere"}, {"path": "/private"}, {"url": "http://other"}, None):
            with self.subTest(args=args), patch.object(lab_tools, "run") as run:
                result = lab_tools.respond({"id": 1, "method": "tools/call", "params": {"name": "matrix_recent", "arguments": args}})
                self.assertTrue(result["result"]["isError"])
                run.assert_not_called()

    def test_worker_uses_existing_deadline_and_byte_cap(self):
        with patch.object(lab_tools, "run", return_value="fixture") as run:
            self.assertEqual(lab_tools.lookup("matrix_recent", {}), "fixture")
        self.assertEqual(run.call_args.args[0][-2:], ["--matrix-history", "10"])
        self.assertIn("--hub-token-file", run.call_args.args[0])

    def test_oversized_or_failed_history_is_refused(self):
        for raw in (b"x" * (lab_tools.MAX_HISTORY_INPUT + 1), b'{"isError": true, "result": "private"}'):
            with self.subTest(size=len(raw)), patch.object(lab_tools, "urlopen", return_value=io.BytesIO(raw)), \
                    patch.object(type(lab_tools.HUB_TOKEN_FILE), "read_text", return_value="fixture-token"):
                with self.assertRaises(ValueError):
                    lab_tools.matrix_recent(10)

    def test_personal_prompt_explains_snapshot_and_live_matrix_lookup(self):
        for web in ((), ("WebSearch", "WebFetch")):
            prompt = prompts.turn_prompt("what did we just say in Matrix?", fork=True, cut_off=None, web=web, lab=True)
            self.assertIn("mcp__janet_lab__matrix_recent", prompt)
            self.assertIn("does not update automatically", prompt)
            self.assertIn("Do not claim you cannot see Matrix", prompt)
        self.assertNotIn("matrix_recent", prompts.COLD_PROFILE)
