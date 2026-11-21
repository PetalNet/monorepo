import json
import http.client
import os
import sys
from unittest.mock import patch

from tests.harness import HeadCase, parse_sse


class LabAccessTest(HeadCase):
    overrides = {"unmerged_channels": ["desk-test"]}
    def setUp(self):
        super().setUp()
        self.stop_head()
        self.lab_token = self.root / "lab-token"
        self.lab_token.write_text("test-lab-credential")
        commands = self.root / "bin"
        commands.mkdir()
        systemctl = commands / "systemctl"
        systemctl.write_text(f"#!{sys.executable}\nprint('[{{\"unit\":\"route-fixture.service\",\"active\":\"active\",\"sub\":\"running\"}}]')\n")
        systemctl.chmod(0o700)
        with patch.dict(os.environ, {"PATH": str(commands) + os.pathsep + os.environ["PATH"]}):
            self.start_head(lab_token_file=str(self.lab_token), warm_up=False)

    def request(self, *args, lab=False, **kwargs):
        if not lab:
            return super().request(*args, **kwargs)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        method, path, body = args
        connection.request(method, path, json.dumps(body), headers={"Authorization": "Bearer " + self.token, "X-Janet-Lab-Token": self.lab_token.read_text(), "content-type": "application/json"})
        response = connection.getresponse()
        raw, status = response.read(), response.status
        connection.close()
        return status, parse_sse(raw.decode()) if response.headers.get("content-type") == "text/event-stream" else json.loads(raw)

    def test_personal_tier_alone_never_grants_lab_tools(self):
        conv = self.open()
        sentences, _ = self.turn(conv, "what builders are running?")
        self.assertEqual(sentences, ["I cannot check the lab on this call."])
        self.assertNotIn("--resume", self.launches()[0]["argv"])
        argv = self.launches()[0]["argv"]
        self.assertEqual(set(json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]), {"janet_call"})

    def test_owner_gets_builders_and_other_credentials_cannot_touch_call(self):
        status, reply = self.request("POST", "/v1/conversations", {"channel": "phone-test", "tier": "personal", "client_ref": "owner-call"}, lab=True)
        self.assertEqual(status, 200)
        conv = reply["id"]
        for action, body in [("turns", {"text": "what builders are running?"}), ("interrupt", {"heard_text": ""}), ("end", {"reason": "test"})]:
            self.assertEqual(self.request("POST", f"/v1/conversations/{conv}/{action}", body)[0], 403)
        self.assertEqual(self.request("POST", "/v1/conversations", {"channel": "phone-test", "tier": "personal", "client_ref": "owner-call"})[0], 403)
        status, events = self.request("POST", f"/v1/conversations/{conv}/turns", {"text": "what builders are running?"}, lab=True)
        self.assertEqual(status, 200)
        said = [data["text"] for kind, data in events if kind == "sentence"]
        self.assertEqual(said[0], "Let me check.")
        results = [json.loads(line) for line in self.claude_log.read_text().splitlines() if "lab_result" in json.loads(line)]
        self.assertFalse(results[0]["lab_error"])
        self.assertIn(results[0]["lab_result"].replace("\n", "; "), " ".join(said))

    def test_guest_ignores_lab_credential(self):
        status, reply = self.request("POST", "/v1/conversations", {"channel": "phone-test", "tier": "guest"}, lab=True)
        self.assertEqual(status, 200)
        sentences, _ = self.turn(reply["id"], "what builders are running?")
        self.assertEqual(sentences, ["I cannot check the lab on this call."])

    def test_owner_call_tools_do_not_require_a_lab_lookup(self):
        status, reply = self.request("POST", "/v1/conversations", {"channel": "phone-test", "tier": "personal"}, lab=True)
        self.assertEqual(status, 200)
        for tool, expected in (("ask_to_end_call", False), ("end_call", True)):
            status, events = self.request("POST", f"/v1/conversations/{reply['id']}/turns",
                                          {"text": "fake-call-tools:" + tool}, lab=True)
            self.assertEqual(status, 200)
            self.assertEqual(next(data for name, data in events if name == "done")["end_conversation"], expected)

    def test_invalid_lab_credential_is_refused_before_a_fork(self):
        self.lab_token.write_text("wrong")
        # The handler reads the configured file on each request, so send a different explicit value.
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("POST", "/v1/conversations", json.dumps({"channel": "phone-test", "tier": "personal"}),
            headers={"Authorization": "Bearer " + self.token, "X-Janet-Lab-Token": "invalid"})
        response = connection.getresponse()
        self.assertEqual(response.status, 403)
        response.read()
        connection.close()
        self.assertFalse(self.claude_log.exists())

    def test_scripted_personal_matrix_conversation_on_desk_test_never_merges(self):
        from tests.test_matrix_recent import event
        self.hub.matrix_events = [event("The synthetic reply", "@janet:test"), event("The synthetic question")]
        status, opened = self.request("POST", "/v1/conversations", {"channel": "desk-test", "tier": "personal"}, lab=True)
        self.assertEqual(status, 200)
        status, events = self.request("POST", f"/v1/conversations/{opened['id']}/turns", {"text": "read recent Matrix messages"}, lab=True)
        self.assertEqual(status, 200)
        speech = " ".join(data["text"] for kind, data in events if kind == "sentence")
        self.assertIn("The synthetic question; The synthetic reply", speech)
        self.assertEqual(self.hub.history_requests, [{"name": "history", "args": {"room": "janet-dm", "limit": 50}}])
        status, ended = self.request("POST", f"/v1/conversations/{opened['id']}/end", {"reason": "test"}, lab=True)
        self.assertEqual(status, 200)
        self.assertEqual(ended["delivery"], "channel is not merged")
        self.assertEqual(self.hub.accepted, [])

    def test_guest_room_and_unverified_personal_never_get_matrix(self):
        for tier, verified in (("guest", True), ("room", True), ("personal", False)):
            with self.subTest(tier=tier):
                status, opened = self.request("POST", "/v1/conversations", {"channel": "desk-test", "tier": tier}, lab=verified)
                self.assertEqual(status, 200)
                status, events = self.request("POST", f"/v1/conversations/{opened['id']}/turns", {"text": "read recent Matrix messages"})
                self.assertEqual(status, 200)
                self.assertEqual([data["text"] for kind, data in events if kind == "sentence"], ["I cannot read recent Matrix messages on this call."])
                self.request("POST", f"/v1/conversations/{opened['id']}/end", {"reason": "test"})
        self.assertEqual(self.hub.history_requests, [])
