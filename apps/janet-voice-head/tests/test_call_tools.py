import json
import subprocess
import unittest

from janet_voice_head.call_tools import CallControl


class CallToolsTest(unittest.TestCase):
    def setUp(self):
        self.control = CallControl()
        self.addCleanup(self.control.close)

    def test_tools_are_refused_outside_caller_turns_including_warmup_and_summary(self):
        self.assertTrue(self.control.call("ask_to_end_call", {})["isError"])
        self.assertTrue(self.control.call("end_call", {})["isError"])

    def test_an_interrupted_question_never_arms_the_following_turn(self):
        self.control.begin_turn()
        self.control.call("ask_to_end_call", {})
        self.control.interrupt()
        self.assertEqual(self.control.finish_turn(True), (False, False))
        self.control.begin_turn()
        self.assertTrue(self.control.call("end_call", {})["isError"])

    def test_an_interrupted_or_failed_goodbye_never_ends_the_call(self):
        for interrupted in (True, False):
            self.control.begin_turn()
            self.control.call("ask_to_end_call", {})
            self.control.finish_turn(True)
            self.control.begin_turn()
            self.assertFalse(self.control.call("end_call", {})["isError"])
            if interrupted:
                self.control.interrupt()
            self.assertEqual(self.control.finish_turn(interrupted), (False, False))

    def test_a_fresh_question_cancels_an_end_requested_in_the_same_turn(self):
        self.control.begin_turn()
        self.control.call("ask_to_end_call", {})
        self.control.finish_turn(True)
        self.control.begin_turn()
        self.control.call("end_call", {})
        self.control.call("ask_to_end_call", {})
        self.assertEqual(self.control.finish_turn(True), (True, False))

    def test_mcp_transport_rejects_unknown_tools_and_arguments(self):
        self.control.begin_turn()
        server = self.control.mcp_config()["janet_call"]
        for name, arguments in (("Bash", {}), ("end_call", {"force": True}), ("ask_to_end_call", [])):
            request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
            result = subprocess.run([server["command"], *server["args"]], input=json.dumps(request) + "\n",
                                    capture_output=True, text=True, check=True, timeout=5)
            self.assertTrue(json.loads(result.stdout)["result"]["isError"])
        self.assertEqual(self.control.finish_turn(True), (False, False))
