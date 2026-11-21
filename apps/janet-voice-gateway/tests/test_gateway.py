import http.client
import json
import os
import signal
import socket
import subprocess
import struct
import threading
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.fakes import MAC, TOKEN, AccessIssuer, ChunkedHead, FakeHead, FakeVoice, WakeListener, closed_port

APP = Path(__file__).resolve().parent.parent / "janet_voice_gateway.py"
AUTH = {"Authorization": "Bearer " + TOKEN, "content-type": "application/json"}


class GatewayCase(unittest.TestCase):
    voice_options: dict = {}
    head_class = FakeHead
    extra_config = ""

    def setUp(self):
        self.head = self.head_class()
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
            + self.extra_config
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


class ChunkedHeadTest(GatewayCase):
    head_class = ChunkedHead

    def test_a_head_that_frames_its_stream_in_chunks_is_relayed_clean_and_ends(self):
        started = time.monotonic()
        status, body, _ = self.request("POST", "/v1/conversations/0123456789ab/turns", {"text": "hello"}, AUTH)
        self.assertEqual(status, 200)
        self.assertEqual(
            body,
            b'event: sentence\ndata: {"text": "First."}\n\nevent: done\ndata: {"end_conversation": false}\n\n',
        )
        self.assertLess(time.monotonic() - started, 5, "the reply waited for the head to close its connection")


class RequestFramingTest(GatewayCase):
    def raw(self, request: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(request)
            reply = b""
            try:
                while data := sock.recv(65536):
                    reply += data
            except TimeoutError:
                self.fail(f"the connection stayed open; so far: {reply!r}")
        return reply

    def test_a_request_hidden_in_a_body_is_not_answered(self):
        hidden = f"GET /v1/voice HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n\r\n".encode()
        reply = self.raw(b"GET /health HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(hidden) + hidden)
        self.assertEqual(reply.count(b"HTTP/1.1 "), 1)
        self.assertNotIn(b'"state"', reply)

    def test_a_chunked_request_body_is_refused_and_not_read_as_a_request(self):
        reply = self.raw(
            f"POST /v1/tts HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n"
            'Transfer-Encoding: chunked\r\n\r\n10\r\n{"text": "hi"}  \r\n0\r\n\r\n'.encode()
        )
        self.assertTrue(reply.startswith(b"HTTP/1.1 411"), reply[:60])
        self.assertEqual(reply.count(b"HTTP/1.1 "), 1)
        self.assertEqual(self.voice.requests_seen, [])

    def test_a_content_length_that_is_not_a_plain_number_is_refused_at_once(self):
        for value in (b"-1", b"abc", b"1e3", b"+5"):
            with self.subTest(value=value):
                reply = self.raw(b"POST /v1/tts HTTP/1.1\r\nHost: x\r\nContent-Length: " + value + b"\r\n\r\n")
                self.assertTrue(reply.startswith(b"HTTP/1.1 400"), reply[:60])

    def test_a_body_over_the_limit_is_refused(self):
        status, _, _ = self.request("POST", "/v1/tts", {"text": "x" * 70000}, AUTH)
        self.assertEqual(status, 413)
        self.assertEqual(self.voice.requests_seen, [])


class AccessTest(GatewayCase):
    def setUp(self):
        self.issuer = AccessIssuer()
        self.addCleanup(self.issuer.shutdown)
        self.extra_config = (
            f'[access]\ncerts_url = "{self.issuer.url}"\naudience = "{AccessIssuer.AUDIENCE}"\n'
            f'issuer = "{self.issuer.url}"\n'
        )
        super().setUp()

    def voice_state(self, **headers):
        return self.request("GET", "/v1/voice", headers={**AUTH, **headers})[0]

    def test_a_request_signed_by_access_with_the_bearer_token_gets_through(self):
        self.assertEqual(self.voice_state(**{"Cf-Access-Jwt-Assertion": self.issuer.token()}), 200)

    def test_the_bearer_token_alone_is_refused(self):
        self.assertEqual(self.voice_state(), 401)

    def test_the_access_token_alone_is_refused(self):
        status, _, _ = self.request("GET", "/v1/voice", headers={"Cf-Access-Jwt-Assertion": self.issuer.token()})
        self.assertEqual(status, 401)

    def test_a_token_that_access_did_not_sign_for_this_application_now_is_refused(self):
        forged = {
            "signed with another key": self.issuer.token(key=self.issuer.other_key()),
            "another application": self.issuer.token(aud=["someone-else"]),
            "another issuer": self.issuer.token(iss="https://evil.example"),
            "expired": self.issuer.token(exp=time.time() - 1),
            "unsigned": self.issuer.token(alg="none"),
            "unknown key id": self.issuer.token(kid="key-2"),
            "tampered claims": self.tampered(),
            "not a token": "x.y.z",
        }
        for name, token in forged.items():
            with self.subTest(name):
                self.assertEqual(self.voice_state(**{"Cf-Access-Jwt-Assertion": token}), 401)

    def tampered(self) -> str:
        header, _, signature = self.issuer.token(aud=["someone-else"]).split(".")
        _, claims, _ = self.issuer.token().split(".")
        return f"{header}.{claims}.{signature}"


class VoiceTest(GatewayCase):
    def test_speech_comes_back_as_one_wav_file_in_the_configured_voice(self):
        status, body, response = self.request("POST", "/v1/tts", {"text": "good morning Parker"}, AUTH)
        self.assertEqual((status, response.getheader("content-type")), (200, "audio/wav"))
        self.assertEqual(body[:4] + body[8:12], b"RIFFWAVE")
        self.assertEqual(int.from_bytes(body[24:28], "little"), 24000)
        self.assertEqual(int.from_bytes(body[40:44], "little"), len(b"goodmorningParker"))
        self.assertEqual(body[44:], b"goodmorningParker")
        self.assertEqual(self.voice.requests_seen, [{"text": "good morning Parker", "voice": {"name": "janet"}}])

    def test_pcm_arrives_before_audio_stop_and_large_chunks_are_split(self):
        self.voice.release_after_first = threading.Event()
        self.addCleanup(self.voice.release_after_first.set)
        connection = self.connection()
        connection.request("POST", "/v1/tts", json.dumps({"text": "a" * 20000 + " bb", "format": "pcm"}), AUTH)
        response = connection.getresponse()
        self.assertEqual(response.getheader("content-type"), "application/octet-stream")
        rate, length = struct.unpack(">II", response.read(8))
        self.assertEqual((rate, length), (24000, 16384))
        self.assertEqual(response.read(length), b"a" * length)
        self.voice.release_after_first.set()
        remaining = response.read()
        records = []
        while remaining:
            rate, length = struct.unpack(">II", remaining[:8])
            records.append((rate, remaining[8:8 + length]))
            remaining = remaining[8 + length:]
        self.assertEqual(records, [(24000, b"a" * 3616), (24000, b"bb")])
        self.assertFalse(self.voice.release_timed_out)

    def test_invalid_format_is_rejected(self):
        self.assertEqual(self.request("POST", "/v1/tts", {"text": "hello", "format": "mp3"}, AUTH)[0], 400)

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

    def test_pcm_failure_has_no_final_http_chunk(self):
        connection = self.connection()
        connection.request("POST", "/v1/tts", json.dumps({"text": "aa bb", "format": "pcm"}), AUTH)
        response = connection.getresponse()
        self.assertEqual(response.read(10), struct.pack(">II", 24000, 2) + b"aa")
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
