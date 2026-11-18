"""Drives the real bridge over a WebSocket, with a fake voice gateway and a fake speech-to-text server."""

import asyncio
import base64
import io
import json
import math
import re
import socketserver
import struct
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

sys.path.insert(0, str(Path(__file__).parent.parent))
import janet_phone  # noqa: E402
import matrix_notice  # noqa: E402
import pairing  # noqa: E402

TOKEN = "Bearer right"


def tone(seconds: float, rate: int = 16000) -> bytes:
    return b"".join(struct.pack("<h", int(8000 * math.sin(i / 8))) for i in range(int(rate * seconds)))


class FakeGateway(BaseHTTPRequestHandler):
    calls: list[tuple[str, dict]] = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self.calls.append((self.path, body))
        if self.headers.get("Authorization") != TOKEN:
            return self._send(401, b"{}")
        if self.path == "/v1/conversations":
            opened = sum(path == "/v1/conversations" for path, _ in self.calls)
            return self._send(200, json.dumps({"id": f"{opened - 1:012x}" if opened > 1 else "0123456789ab"}).encode())
        if self.path == "/v1/conversations/0123456789ab/turns" and body["text"] == "are you there":
            return self._send(409, b'{"error": "the conversation has ended"}')
        if self.path == "/v1/tts":
            out = io.BytesIO()
            with wave.open(out, "wb") as wav:
                wav.setnchannels(1), wav.setsampwidth(2), wav.setframerate(24000)
                wav.writeframes(tone(3.0 if "story" in body["text"] else 0.2, 24000))
            return self._send(200, out.getvalue())
        if self.path.endswith("/turns") and body["text"] == "break":
            return self._send(500, b"{}")
        if self.path.endswith("/turns"):
            done = {"end_conversation": body["text"] == "goodbye"}
            events = f'event: sentence\ndata: {{"text": "You said {body["text"]}."}}\n\nevent: done\ndata: {json.dumps(done)}\n\n'
            return self._send(200, events.encode())
        return self._send(200, b'{"merged": true}')

    def _send(self, status: int, body: bytes):
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class FakeStt(socketserver.StreamRequestHandler):
    texts: list[str] = []

    def handle(self):
        while line := self.rfile.readline():
            header = json.loads(line)
            self.rfile.read(header.get("payload_length") or 0)
            if header["type"] == "audio-stop":
                data = json.dumps({"type": "transcript", "data": {"text": self.texts.pop(0)}})
                self.wfile.write(data.encode() + b"\n")
                return


class CallTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        FakeGateway.calls = []
        self.gateway = ThreadingHTTPServer(("127.0.0.1", 0), FakeGateway)
        self.stt = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeStt)
        for server in (self.gateway, self.stt):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.shutdown)
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "head-token").write_text("right\n")
        (self.dir / "access.json").write_text('{"client_id": "id.access", "client_secret": "s3cret"}')
        self.devices = pairing.Devices(self.dir / "devices.json")
        self.phone = {"Authorization": "Bearer " + self.devices.add("Test Phone", "parker")}
        config = janet_phone.Config(
            listen="127.0.0.1:0", gateway=f"http://127.0.0.1:{self.gateway.server_port}",
            stt=f"127.0.0.1:{self.stt.server_address[1]}", tier="guest", channel="phone-test",
            disclosure="This is an automated assistant for Parker.",
            notify=["sh", "-c", f"cat > {self.dir}/notice; echo $JANET_PHONE_DESTINATION > {self.dir}/destination"],
            record_dir=str(self.dir / "calls"),
            endpoint={"silence_ms": 200}, head_token_file=str(self.dir / "head-token"),
            devices_file=str(self.dir / "devices.json"))
        self.server = await janet_phone.serve(
            lambda ws: janet_phone.handle(ws, config), "127.0.0.1", 0,
            process_request=lambda ws, request: janet_phone.admit(ws, request, config, self.devices))
        self.codes = pairing.Codes(300)
        self.http = pairing.serve("127.0.0.1:0", self.devices, self.codes, url="wss://bridge.example/v1/call",
                                  access_file=str(self.dir / "access.json"), users=["parker"])
        self.addCleanup(self.http.shutdown)
        self.addAsyncCleanup(self._close)
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/v1/call"

    async def _close(self):
        self.server.close()
        await self.server.wait_closed()

    async def _until(self, ws, wanted: str) -> list:
        seen = []
        while True:
            message = await asyncio.wait_for(ws.recv(), 10)
            seen.append(message)
            if isinstance(message, str) and json.loads(message)["type"] == wanted:
                return seen

    async def _notice(self) -> str:
        for _ in range(100):
            if (self.dir / "notice").exists() and (text := (self.dir / "notice").read_text()):
                return text
            await asyncio.sleep(0.05)
        self.fail("no notice was posted")

    async def test_a_call_is_disclosed_answered_and_reported(self):
        FakeStt.texts = ["what is this", "goodbye"]
        async with connect(self.url, additional_headers=self.phone) as ws:
            first = await asyncio.wait_for(ws.recv(), 10)
            self.assertEqual(json.loads(first), {"type": "audio", "rate": 24000})
            self.assertIsInstance(await asyncio.wait_for(ws.recv(), 10), bytes)
            for _ in range(2):
                await asyncio.sleep(0.4)
                await ws.send(tone(0.5))
                await ws.send(bytes(16000))
            seen = await self._until(ws, "bye")
            self.assertTrue(any(isinstance(message, bytes) for message in seen))
        notice = await self._notice()
        self.assertIn("Janet: This is an automated assistant for Parker.", notice)
        self.assertEqual((self.dir / "destination").read_text().strip(), "notebook")
        self.assertIn("Caller: what is this", notice)
        self.assertIn("Janet: You said what is this.", notice)
        self.assertLess(notice.index("automated assistant"), notice.index("Caller: what is this"))
        opened = [body for path, body in FakeGateway.calls if path == "/v1/conversations"]
        self.assertEqual([(body["tier"], body["channel"]) for body in opened], [("guest", "phone-test")])
        self.assertIn("/v1/conversations/0123456789ab/end", [path for path, _ in FakeGateway.calls])
        self.assertEqual(len(list((self.dir / "calls").glob("*.wav"))), 2)

    async def test_speaking_over_a_reply_cuts_it_off(self):
        FakeStt.texts = ["tell me a story", "stop"]
        async with connect(self.url, additional_headers=self.phone) as ws:
            await ws.send(tone(0.5))
            await ws.send(bytes(16000))
            while [body for path, body in FakeGateway.calls if path == "/v1/tts"][-1:] != [{"text": "You said tell me a story."}]:
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.5)
            await ws.send(tone(0.5))
            await self._until(ws, "clear")
            for _ in range(100):
                if any(path.endswith("/interrupt") for path, _ in FakeGateway.calls):
                    break
                await asyncio.sleep(0.05)
        self.assertIn("/v1/conversations/0123456789ab/interrupt", [path for path, _ in FakeGateway.calls])
        self.assertIn("[cut off]", await self._notice())

    async def test_a_dropped_connection_still_ends_the_call_and_reports_it(self):
        async with connect(self.url, additional_headers=self.phone) as ws:
            await asyncio.wait_for(ws.recv(), 10)
            ws.transport.abort()
        self.assertIn("automated assistant", await self._notice())
        self.assertIn("/v1/conversations/0123456789ab/end", [path for path, _ in FakeGateway.calls])

    async def test_a_plain_request_opens_no_conversation(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.server.sockets[0].getsockname()[1])
        writer.write(b"GET /v1/call HTTP/1.1\r\nHost: x\r\nAuthorization: " + self.phone["Authorization"].encode() + b"\r\n\r\n")
        status = await asyncio.wait_for(reader.readline(), 10)
        writer.close()
        self.assertIn(b"404", status)
        self.assertEqual(FakeGateway.calls, [])

    async def test_a_conversation_the_head_ended_is_reopened(self):
        FakeStt.texts = ["are you there"]
        async with connect(self.url, additional_headers=self.phone) as ws:
            await asyncio.sleep(0.4)
            await ws.send(tone(0.5))
            await ws.send(bytes(16000))
            await asyncio.sleep(1.5)
        self.assertIn("Janet: You said are you there.", await self._notice())
        self.assertIn("/v1/conversations/000000000001/end", [path for path, _ in FakeGateway.calls])

    async def test_a_failed_reply_does_not_drop_the_call(self):
        FakeStt.texts = ["break", "what is this"]
        async with connect(self.url, additional_headers=self.phone) as ws:
            for _ in range(2):
                await asyncio.sleep(0.4)
                await ws.send(tone(0.5))
                await ws.send(bytes(16000))
            await asyncio.sleep(1.5)
        self.assertIn("Janet: You said what is this.", await self._notice())

    async def test_a_phone_that_is_not_paired_gets_no_socket_and_no_conversation(self):
        for headers in ({}, {"Authorization": "Bearer right"}, {"Authorization": "Bearer guess"}):
            with self.assertRaises(InvalidStatus) as refused:
                async with connect(self.url, additional_headers=headers):
                    pass
            self.assertEqual(refused.exception.response.status_code, 403)
        self.assertEqual(FakeGateway.calls, [])

    async def test_an_unpaired_phone_can_no_longer_call(self):
        ident = self.devices.listing()[0][0]
        self.assertEqual(self.devices.revoke(ident), ["Test Phone"])
        with self.assertRaises(InvalidStatus):
            async with connect(self.url, additional_headers=self.phone):
                pass

    async def test_the_record_names_the_device(self):
        async with connect(self.url, additional_headers=self.phone) as ws:
            await asyncio.wait_for(ws.recv(), 10)
        self.assertIn("from Test Phone", await self._notice())

    def _http(self, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.http.server_port}{path}", method=method,
                                         data=None if body is None else json.dumps(body).encode(), headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    async def test_the_pairing_page_is_for_the_signed_in_owner_only(self):
        self.assertEqual((await asyncio.to_thread(self._http, "GET", "/pair"))[0], 403)
        stranger = {"X-authentik-username": "someone-else"}
        self.assertEqual((await asyncio.to_thread(self._http, "GET", "/pair", None, stranger))[0], 403)

    async def test_a_phone_pairs_with_the_page_code_once_and_can_then_call(self):
        status, page = await asyncio.to_thread(self._http, "GET", "/pair", None, {"X-authentik-username": "parker"})
        self.assertEqual(status, 200)
        self.assertIn("<svg", page)
        link = re.search(r'href="(janetcall://pair\?u=[^"]+)"', page)[1]
        encoded = link.split("u=")[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        self.assertEqual((payload["url"], payload["cf_id"], payload["cf_secret"]),
                         ("wss://bridge.example/v1/call", "id.access", "s3cret"))
        self.assertNotIn("token", payload)
        paired = {"code": payload["code"], "name": "Galaxy S23"}
        status, body = await asyncio.to_thread(self._http, "POST", "/v1/call/pair", paired)
        self.assertEqual(status, 200)
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", paired))[0], 403)
        async with connect(self.url, additional_headers={"Authorization": "Bearer " + json.loads(body)["token"]}) as ws:
            await asyncio.wait_for(ws.recv(), 10)
        self.assertIn("from Galaxy S23", await self._notice())

    async def test_a_wrong_or_expired_code_pairs_nothing(self):
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": "guess"}))[0], 403)
        code, _ = self.codes.issue("parker", now=time.time() - 301)
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": code}))[0], 403)
        self.assertEqual(len(self.devices.listing()), 1)


class DestinationTest(unittest.TestCase):
    def config(self, **changes) -> janet_phone.Config:
        base = dict(listen="", gateway="", stt="", tier="guest", channel="phone", disclosure="")
        return janet_phone.Config(**{**base, **changes})

    def test_only_a_real_inbound_call_reaches_the_owner(self):
        self.assertEqual(janet_phone.destination(self.config(source="inbound")), "owner")

    def test_a_bridge_that_does_not_say_what_it_is_goes_to_the_notebook(self):
        self.assertEqual(janet_phone.destination(self.config()), "notebook")

    def test_test_and_dev_calls_go_to_the_notebook_whatever_the_source_says(self):
        for changes in ({"source": "test"}, {"source": "app"}, {"source": "inbound", "channel": "desk-test"},
                        {"source": "inbound", "channel": "phone-dev"}, {"source": "inbound", "channel": "Desk-TEST"}):
            self.assertEqual(janet_phone.destination(self.config(**changes)), "notebook", changes)


class NoticeRoutingTest(unittest.TestCase):
    def test_a_file_name_carries_its_destination(self):
        self.assertEqual(matrix_notice.destination_of("1794981808582657005.notebook.txt"), "notebook")

    def test_a_file_name_without_a_destination_has_none(self):
        for name in ("1794981808582657005.txt", "1794981808582657005..txt", "a.owner.notebook.txt", "owner.txt"):
            self.assertEqual(matrix_notice.destination_of(name), "", name)

    def test_a_record_with_no_room_is_set_aside_and_later_records_still_go(self):
        outbox, sent = Path(tempfile.mkdtemp()), []
        (outbox / "1.txt").write_text("old format")
        (outbox / "2.notebook.txt").write_text("a test call")

        def send(to, text):
            sent.append((to, text))
            raise KeyboardInterrupt  # leaves the endless loop once the routable record is reached

        with self.assertRaises(KeyboardInterrupt):
            matrix_notice.watch(outbox, {"owner": "!a:x", "notebook": "!b:x"}, send)
        self.assertEqual(sent, [("notebook", "a test call")])
        self.assertTrue((outbox / "1.unrouted").exists())

    def test_two_destinations_cannot_share_a_room(self):
        self.assertEqual(matrix_notice.rooms_of(["owner=!a:x", "notebook=!b:x"]), {"owner": "!a:x", "notebook": "!b:x"})
        with self.assertRaises(ValueError):
            matrix_notice.rooms_of(["owner=!a:x", "notebook=!a:x"])


class EndpointerTest(unittest.TestCase):
    def test_speech_then_silence_is_one_utterance(self):
        endpointer = janet_phone.Endpointer(silence_ms=200)
        events = endpointer.feed(bytes(16000) + tone(0.5) + bytes(16000))
        self.assertEqual(events[0], "start")
        self.assertEqual(len(events), 2)
        self.assertGreaterEqual(len(events[1]), len(tone(0.5)))

    def test_silence_is_no_utterance(self):
        self.assertEqual(janet_phone.Endpointer().feed(bytes(64000)), [])


if __name__ == "__main__":
    unittest.main()
