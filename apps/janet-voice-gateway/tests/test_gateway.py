import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.fakes import MAC, TOKEN, FakeHead, FakeVoice, WakeListener, closed_port

APP = Path(__file__).resolve().parent.parent / "janet_voice_gateway.py"
AUTH = {"Authorization": "Bearer " + TOKEN, "content-type": "application/json"}


class GatewayCase(unittest.TestCase):
    voice_options: dict = {}

    def setUp(self):
        self.head = FakeHead()
        self.voice = FakeVoice(**self.voice_options)
        self.wake = WakeListener()
        self.addCleanup(self.head.shutdown)
        self.addCleanup(self.voice.shutdown)
        self.addCleanup(self.wake.close)
        self.port = int(closed_port().rpartition(":")[2])
        self.start(self.voice.address)

    def start(self, wyoming: str) -> None:
        folder = Path(tempfile.mkdtemp())
        (folder / "token").write_text(TOKEN + "\n")
        (folder / "gateway.toml").write_text(
            f'listen = ["127.0.0.1:{self.port}"]\n'
            f'token_file = "{folder / "token"}"\n'
            f'head = "{self.head.url}"\n'
            f'[voice]\nwyoming = "{wyoming}"\nname = "janet"\nmac = "{MAC}"\nbroadcast = "{self.wake.address}"\n'
        )
        self.process = subprocess.Popen([sys.executable, str(APP), "--config", str(folder / "gateway.toml")])
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 10
        while True:
            try:
                if self.request("GET", "/health")[0] == 200:
                    return
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)

    def stop(self) -> None:
        if self.process.poll() is None:
            os.kill(self.process.pid, signal.SIGTERM)
            self.process.wait(5)

    def connection(self) -> http.client.HTTPConnection:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(connection.close)
        return connection

    def request(self, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        connection = self.connection()
        connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read(), response


class AuthTest(GatewayCase):
    def test_health_needs_no_token(self):
        status, body, _ = self.request("GET", "/health")
        self.assertEqual((status, json.loads(body)["ok"]), (200, True))

    def test_every_other_route_refuses_a_missing_or_wrong_token(self):
        routes = [("GET", "/v1/voice"), ("POST", "/v1/voice/wake"), ("POST", "/v1/tts"), ("POST", "/v1/conversations"),
                  ("POST", "/v1/conversations/0123456789ab/turns")]
        for method, path in routes:
            for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN}):
                with self.subTest(path=path, headers=headers):
                    status, _, _ = self.request(method, path, {"text": "hi", "channel": "mac"}, headers)
                    self.assertEqual(status, 401)
        self.assertEqual(self.head.calls, [])
        self.assertEqual(self.voice.requests_seen, [])
        self.assertEqual(self.wake.packets(), [])

    def test_the_head_checks_the_token_again(self):
        # The gateway forwards the caller's own header; it does not substitute a token of its own.
        self.head.RequestHandlerClass = type("Strict", (self.head.RequestHandlerClass,), {})
        seen = []
        original = self.head.RequestHandlerClass.do_POST

        def record(handler):
            seen.append(handler.headers.get("Authorization"))
            original(handler)

        self.head.RequestHandlerClass.do_POST = record
        self.request("POST", "/v1/conversations", {"channel": "mac"}, AUTH)
        self.assertEqual(seen, ["Bearer " + TOKEN])


class HeadTest(GatewayCase):
    def test_opening_a_conversation_reaches_the_head_and_returns_its_reply(self):
        status, body, _ = self.request("POST", "/v1/conversations", {"channel": "mac", "tier": "personal"}, AUTH)
        self.assertEqual((status, json.loads(body)), (200, {"id": "0123456789ab"}))
        self.assertEqual(self.head.calls, [("/v1/conversations", {"channel": "mac", "tier": "personal"})])

    def test_a_turn_delivers_each_sentence_while_the_head_is_still_talking(self):
        connection = self.connection()
        connection.request("POST", "/v1/conversations/0123456789ab/turns", body='{"text": "hello"}', headers=AUTH)
        response = connection.getresponse()
        self.assertEqual(response.getheader("content-type"), "text/event-stream")
        first = response.readline() + response.readline()
        self.head.release_turn.set()
        self.assertIn(b'"First."', first)
        rest = response.read()
        # The head sent the rest because it was released, not because it gave up waiting:
        # the first sentence reached the caller while the head was still talking.
        self.assertFalse(self.head.turn_timed_out)
        self.assertIn(b'"Second."', rest)
        self.assertIn(b"event: done", rest)

    def test_a_head_error_keeps_its_status_and_body(self):
        status, body, _ = self.request("POST", "/v1/conversations/0123456789ab/end", {"reason": "x"}, AUTH)
        self.assertEqual((status, json.loads(body)), (409, {"error": "conversation already ended"}))

    def test_only_the_conversation_routes_reach_the_head(self):
        for path in ("/v1/other", "/health", "/v1/conversations/../../admin", "/v1/conversations/0123456789ab/delete"):
            with self.subTest(path=path):
                self.assertEqual(self.request("POST", path, {}, AUTH)[0], 404)
        self.assertEqual(self.head.calls, [])

    def test_an_unreachable_head_is_a_502(self):
        self.head.shutdown()
        self.head.server_close()
        self.assertEqual(self.request("POST", "/v1/conversations", {"channel": "mac"}, AUTH)[0], 502)


class VoiceTest(GatewayCase):
    def test_speech_comes_back_as_one_wav_file_in_the_configured_voice(self):
        status, body, response = self.request("POST", "/v1/tts", {"text": "good morning Parker"}, AUTH)
        self.assertEqual((status, response.getheader("content-type")), (200, "audio/wav"))
        self.assertEqual(body[:4] + body[8:12], b"RIFFWAVE")
        self.assertEqual(int.from_bytes(body[24:28], "little"), 24000)
        self.assertEqual(int.from_bytes(body[40:44], "little"), len(b"goodmorningParker"))
        self.assertEqual(body[44:], b"goodmorningParker")
        self.assertEqual(self.voice.requests_seen, [{"text": "good morning Parker", "voice": {"name": "janet"}}])

    def test_text_is_required(self):
        for body in ({}, {"text": ""}, {"text": 5}):
            self.assertEqual(self.request("POST", "/v1/tts", body, AUTH)[0], 400)

    def test_an_awake_voice_host_reports_up_and_gets_no_wake_packet(self):
        status, body, _ = self.request("GET", "/v1/voice", headers=AUTH)
        self.assertEqual((status, json.loads(body)), (200, {"state": "up"}))
        self.request("POST", "/v1/tts", {"text": "hello"}, AUTH)
        self.assertEqual(self.wake.packets(), [])

    def test_wake_sends_the_magic_packet_for_the_configured_card(self):
        self.assertEqual(self.request("POST", "/v1/voice/wake", {}, AUTH)[0], 200)
        mac = bytes.fromhex(MAC.replace(":", ""))
        self.assertEqual(self.wake.packets(), [b"\xff" * 6 + mac * 16])


class FailingVoiceTest(GatewayCase):
    voice_options = {"fail_after_first_chunk": True}

    def test_a_voice_error_fails_the_transfer_instead_of_returning_half_a_sentence(self):
        connection = self.connection()
        connection.request("POST", "/v1/tts", body='{"text": "one two three"}', headers=AUTH)
        response = connection.getresponse()
        with self.assertRaises(http.client.IncompleteRead):
            response.read()


class AsleepTest(GatewayCase):
    def start(self, wyoming: str) -> None:
        super().start(closed_port())

    def test_a_sleeping_voice_host_reports_asleep(self):
        status, body, _ = self.request("GET", "/v1/voice", headers=AUTH)
        self.assertEqual((status, json.loads(body)), (200, {"state": "asleep"}))
        self.assertEqual(self.wake.packets(), [])

    def test_speech_for_a_sleeping_host_wakes_it_and_asks_the_client_to_retry(self):
        status, body, response = self.request("POST", "/v1/tts", {"text": "hello"}, AUTH)
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["state"], "waking")
        self.assertEqual(response.getheader("retry-after"), "5")
        mac = bytes.fromhex(MAC.replace(":", ""))
        self.assertEqual(self.wake.packets(), [b"\xff" * 6 + mac * 16])


if __name__ == "__main__":
    unittest.main()
