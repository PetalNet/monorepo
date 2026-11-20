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
from unittest import mock
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
    seen: list[tuple[str, str]] = []
    voice_down = False
    lab_tokens = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self.calls.append((self.path, body))
        self.lab_tokens.append(self.headers.get("X-Janet-Lab-Token", ""))
        self.seen.append((self.headers.get("Authorization", ""), self.headers.get("Cf-Access-Jwt-Assertion", "")))
        if self.headers.get("Authorization") != TOKEN:
            return self._send(401, b"{}")
        if self.path == "/v1/conversations":
            opened = sum(path == "/v1/conversations" for path, _ in self.calls)
            return self._send(200, json.dumps({"id": f"{opened - 1:012x}" if opened > 1 else "0123456789ab"}).encode())
        if self.path == "/v1/conversations/0123456789ab/turns" and body["text"] == "are you there":
            return self._send(409, b'{"error": "the conversation has ended"}')
        if self.path == "/v1/tts" and self.voice_down:
            return self._send(500, b"{}")
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
            sentence = json.dumps({"text": "You said " + body["text"] + "."})
            events = f'event: sentence\ndata: {sentence}\n\nevent: done\ndata: {json.dumps(done)}\n\n'
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
        heard = False
        while line := self.rfile.readline():
            header = json.loads(line)
            heard = any(self.rfile.read(header.get("payload_length") or 0)) or heard
            if header["type"] == "audio-stop":
                # Silence, which a warm-up sends, is nobody's utterance.
                data = json.dumps({"type": "transcript", "data": {"text": self.texts.pop(0) if heard else ""}})
                self.wfile.write(data.encode() + b"\n")
                return


class CallTest(unittest.IsolatedAsyncioTestCase):
    async def test_failed_reply_audio_reports_only_the_completed_prefix(self):
        for prefix in ([], ["The completed sentence."]):
            with self.subTest(prefix=prefix):
                gateway = janet_phone.Gateway(f"http://127.0.0.1:{self.gateway.server_port}", {"Authorization": TOKEN})
                call = janet_phone.Call(mock.AsyncMock(), self.config, gateway, "0123456789ab")
                events = [("sentence", {"text": text}) for text in [*prefix, "The unplayed sentence."]]
                events.append(("done", {"end_conversation": True}))
                audio = [(16000, tone(.1)) for _ in prefix]
                with mock.patch.object(gateway, "turn", return_value=iter(events)), mock.patch.object(
                    gateway, "speech", side_effect=[*audio, OSError("TTS failed")]
                ):
                    with self.assertRaises(OSError):
                        await call.reply("caller turn", time.monotonic(), {"endpoint_ms": 0})
                interrupts = [body for path, body in FakeGateway.calls if path.endswith("/interrupt")]
                self.assertEqual(interrupts[-1:], [{"heard_text": " ".join(prefix)}])
                self.assertFalse(any(path.endswith("/end") for path, _ in FakeGateway.calls))

    async def asyncSetUp(self):
        FakeGateway.calls, FakeGateway.seen, FakeGateway.voice_down, FakeGateway.lab_tokens = [], [], False, []
        janet_phone.DISCLOSURES.clear()
        janet_phone.WARMED[0] = 0.0
        self.gateway = ThreadingHTTPServer(("127.0.0.1", 0), FakeGateway)
        self.stt = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeStt)
        for server in (self.gateway, self.stt):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.shutdown)
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "head-token").write_text("right\n")
        (self.dir / "proxy-secret").write_text("from-the-proxy\n")
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
            devices_file=str(self.dir / "devices.json"), cache_dir=str(self.dir / "cache"))
        (self.dir / "cache").mkdir()
        self.config = config
        self.server = await janet_phone.serve(
            lambda ws: janet_phone.handle(ws, config), "127.0.0.1", 0,
            process_request=lambda ws, request: janet_phone.admit(ws, request, config, self.devices))
        self.codes = pairing.Codes(300)
        self.http = pairing.serve("127.0.0.1:0", self.devices, self.codes, url="wss://bridge.example/v1/call",
                                  access_file=str(self.dir / "access.json"), users=["parker"],
                                  proxy_secret_file=str(self.dir / "proxy-secret"),
                                  on_paired=lambda name, by: self.announced.append((name, by)),
                                  routes={"/v1/call/warm": janet_phone.warm_route(config, self.devices)})
        self.announced = []
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
            while not isinstance(await asyncio.wait_for(ws.recv(), 10), bytes):
                pass
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
        timeline = json.loads(next((self.dir / "calls").glob("*.txt")).read_text().splitlines()[-1])
        self.assertEqual([line["who"] for line in timeline][:3], ["Janet", "Caller", "Janet"])
        self.assertEqual(timeline, sorted(timeline, key=lambda line: line["t"]))

    async def test_with_a_line_tone_the_line_is_never_dead_air(self):
        import dataclasses

        import numpy as np

        config = dataclasses.replace(self.config, line_tone="AL30 V80")
        server = await janet_phone.serve(
            lambda ws: janet_phone.handle(ws, config), "127.0.0.1", 0,
            process_request=lambda ws, request: janet_phone.admit(ws, request, config, self.devices))
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        FakeStt.texts = []
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1/call"
        async with connect(url, additional_headers=self.phone) as ws:
            while True:  # the disclosure is spoken, then the line is listening
                message = await asyncio.wait_for(ws.recv(), 10)
                if isinstance(message, str) and json.loads(message) == {"type": "state", "value": "listening"}:
                    break
            await asyncio.sleep(0.3)
            hum = []
            for _ in range(20):
                message = await asyncio.wait_for(ws.recv(), 5)
                if isinstance(message, bytes):
                    hum.append(np.frombuffer(message, "<i2"))
            quiet = np.concatenate(hum) if hum else np.zeros(1)
        self.assertGreater(len(hum), 5)
        rms = float(np.sqrt(np.mean(np.square(quiet.astype(np.float64)))))
        self.assertTrue(0 < rms < 1500, rms)  # a hiss, not silence and not speech

    async def _server_with(self, **changes):
        import dataclasses

        config = dataclasses.replace(self.config, **changes)
        server = await janet_phone.serve(
            lambda ws: janet_phone.handle(ws, config), "127.0.0.1", 0,
            process_request=lambda ws, request: janet_phone.admit(ws, request, config, self.devices))
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        return f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1/call"

    async def test_when_janet_ends_the_call_an_earcon_comes_before_the_bye_and_the_log_says_who(self):
        url = await self._server_with(hangup_earcon="HL40 HP880 HI5 HN150 HG30")
        FakeStt.texts = ["goodbye"]
        with self.assertLogs("janet-phone", "INFO") as logs:
            async with connect(url, additional_headers=self.phone) as ws:
                while not isinstance(await asyncio.wait_for(ws.recv(), 10), bytes):
                    pass
                await asyncio.sleep(0.4)
                await ws.send(tone(0.5))
                await ws.send(bytes(16000 * 4))
                order = []
                while True:
                    message = await asyncio.wait_for(ws.recv(), 15)
                    order.append("audio" if isinstance(message, bytes) else json.loads(message)["type"])
                    if order[-1] == "bye":
                        break
                last_audio = [m for m in order if m == "audio"]
        self.assertGreater(len(last_audio), 0)
        self.assertEqual(order[-2], "audio", "the earcon is the last audio before the bye")
        await asyncio.sleep(0.3)
        self.assertTrue(any("ended by Janet (the head ended the conversation)" in line for line in logs.output), logs.output)

    async def test_without_an_earcon_code_the_bye_comes_with_no_extra_audio(self):
        FakeStt.texts = ["goodbye"]
        async with connect(self.url, additional_headers=self.phone) as ws:
            while not isinstance(await asyncio.wait_for(ws.recv(), 10), bytes):
                pass
            await asyncio.sleep(0.4)
            await ws.send(tone(0.5))
            await ws.send(bytes(16000 * 4))
            seen = await self._until(ws, "bye")
        self.assertTrue(isinstance(seen[-1], str) and json.loads(seen[-1])["type"] == "bye")

    async def test_a_phone_that_drops_the_line_is_logged_as_the_far_side_and_a_silent_one_is_noticed(self):
        url = await self._server_with()
        FakeStt.texts = []
        with mock.patch.object(janet_phone, "STALL_S", 0.4), self.assertLogs("janet-phone", "INFO") as logs:
            async with connect(url, additional_headers=self.phone) as ws:
                await self._until(ws, "state")
                await asyncio.sleep(1.2)  # the phone sends nothing: a stalled uplink
            await asyncio.sleep(0.5)
        text = "\n".join(logs.output)
        self.assertIn("no audio from the phone", text)
        self.assertIn("ended by the far side", text)
        self.assertNotIn("ended by Janet", text)

    async def test_a_phone_that_goes_quiet_and_then_sends_again_keeps_its_call(self):
        url = await self._server_with()
        FakeStt.texts = []
        with mock.patch.object(janet_phone, "STALL_S", 0.3), self.assertLogs("janet-phone", "INFO") as logs:
            async with connect(url, additional_headers=self.phone) as ws:
                await self._until(ws, "state")
                await asyncio.sleep(1.0)  # silent for several stall periods
                await ws.send(tone(0.2))
                await asyncio.sleep(0.5)
                await ws.send(bytes(3200))  # the call still hears the phone
                await asyncio.sleep(0.3)
            await asyncio.sleep(0.4)
        text = "\n".join(logs.output)
        self.assertIn("audio from the phone again", text)
        self.assertIn("ended by the far side", text)

    async def test_speaking_over_a_reply_cuts_it_off(self):
        FakeStt.texts = ["tell me a story", "stop"]
        async with connect(self.url, additional_headers=self.phone) as ws:
            await ws.send(tone(0.5))
            await ws.send(bytes(16000))
            while {"text": "You said tell me a story."} not in [body for path, body in FakeGateway.calls if path == "/v1/tts"]:
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

    async def test_the_screen_is_told_state_words_and_levels(self):
        FakeStt.texts = ["what is this"]
        events = []
        async with connect(self.url, additional_headers=self.phone) as ws:
            await asyncio.sleep(0.4)
            await ws.send(tone(0.5))
            await ws.send(bytes(16000))
            try:
                while True:
                    message = await asyncio.wait_for(ws.recv(), 2)
                    if isinstance(message, str):
                        events.append(json.loads(message))
            except TimeoutError:
                pass
        states = [event["value"] for event in events if event["type"] == "state"]
        self.assertEqual(states[:5], ["speaking", "listening", "thinking", "speaking", "listening"])
        hers = [event for event in events if event["type"] == "words" and event["side"] == "her"]
        self.assertEqual([event["text"] for event in hers],
                         ["This is an automated assistant for Parker.", "You said what is this."])
        self.assertEqual([word["w"] for word in hers[1]["words"]], ["You", "said", "what", "is", "this."])
        self.assertEqual(hers[1]["words"][0]["t"], 0.0)
        self.assertAlmostEqual(sum(word["d"] for word in hers[1]["words"]), 0.2, delta=0.03)
        his = [event for event in events if event["type"] == "words" and event["side"] == "him"]
        self.assertEqual(his, [{"type": "words", "side": "him", "text": "what is this", "words": []}])
        levels = [event for event in events if event["type"] == "level"]
        self.assertTrue(any(event["her"] > 0.5 for event in levels), "her level follows her audio")
        self.assertTrue(any(event["him"] > 0.5 and event["her"] == 0 for event in levels), "his level follows the microphone")

    async def test_the_disclosure_survives_a_restart_and_a_sleeping_voice(self):
        async with connect(self.url, additional_headers=self.phone) as ws:
            await asyncio.wait_for(ws.recv(), 10)
        janet_phone.DISCLOSURES.clear()
        FakeGateway.voice_down = True
        async with connect(self.url, additional_headers=self.phone) as ws:
            self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 3)), {"type": "audio", "rate": 24000})

    async def test_a_damaged_cache_file_is_replaced_not_played(self):
        for damage in (b"", b"not audio at all", None):
            janet_phone.DISCLOSURES.clear()
            for old in (self.dir / "cache").glob("*.wav"):
                old.unlink()
            async with connect(self.url, additional_headers=self.phone) as ws:
                await asyncio.wait_for(ws.recv(), 10)
            cached = next((self.dir / "cache").glob("*.wav"))
            if damage is None:  # a header that promises more audio than the file holds
                cached.write_bytes(cached.read_bytes()[:200])
            else:
                cached.write_bytes(damage)
            janet_phone.DISCLOSURES.clear()
            async with connect(self.url, additional_headers=self.phone) as ws:
                heard = b""
                while len(heard) < 9600:
                    message = await asyncio.wait_for(ws.recv(), 10)
                    heard += message if isinstance(message, bytes) else b""
            with wave.open(str(cached)) as wav:
                self.assertEqual(wav.getnframes(), 4800, damage)

    async def test_warm_up_runs_at_most_once_a_minute(self):
        for _ in range(3):
            self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/warm", {}, self.phone))[0], 202)
        await asyncio.sleep(1)
        self.assertEqual([body["text"] for path, body in FakeGateway.calls if path == "/v1/tts"].count("Okay."), 1)

    async def test_warm_up_is_for_paired_phones_and_readies_speech_before_a_call(self):
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/warm", {}))[0], 403)
        self.assertEqual(FakeGateway.calls, [])
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/warm", {}, self.phone))[0], 202)
        for _ in range(100):
            spoken = [body["text"] for path, body in FakeGateway.calls if path == "/v1/tts"]
            if "This is an automated assistant for Parker." in spoken and "Okay." in spoken:
                break
            await asyncio.sleep(0.05)
        else:
            self.fail("warm-up did not synthesize")
        self.assertTrue(list((self.dir / "cache").glob("*.wav")))

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
        self.assertIsNone(self.devices.revoke(""))
        self.assertEqual(self.devices.revoke(ident), "Test Phone")
        with self.assertRaises(InvalidStatus):
            async with connect(self.url, additional_headers=self.phone):
                pass

    async def test_the_record_names_the_device(self):
        async with connect(self.url, additional_headers=self.phone) as ws:
            await asyncio.wait_for(ws.recv(), 10)
        self.assertIn("the device named 'Test Phone'", await self._notice())

    def _http(self, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.http.server_port}{path}", method=method,
                                         data=None if body is None else json.dumps(body).encode(), headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    async def test_the_pairing_page_is_for_the_signed_in_owner_through_the_proxy_only(self):
        owner = {"X-authentik-username": "parker", "X-Janet-Pair-Proxy": "from-the-proxy"}
        refused = [
            {},
            {"X-authentik-username": "parker"},  # a local process that sets the header itself
            {"X-authentik-username": "parker", "X-Janet-Pair-Proxy": "guess"},
            {"X-authentik-username": "someone-else", "X-Janet-Pair-Proxy": "from-the-proxy"},
            {**owner, "Sec-Fetch-Site": "cross-site"},
        ]
        for headers in refused:
            self.assertEqual((await asyncio.to_thread(self._http, "GET", "/pair", None, headers))[0], 403, headers)
        for path in ("/", "/v1/call/pair", "/v1/call/../pair", "/pair/"):
            self.assertIn((await asyncio.to_thread(self._http, "GET", path, None, owner))[0], (400, 404), path)
        self.assertEqual((await asyncio.to_thread(self._http, "GET", "/pair", None, owner))[0], 200)
        # Arriving from the sign-on host or from a link elsewhere is a navigation, and is served.
        for site in ("same-site", "cross-site"):
            arrived = {**owner, "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
            self.assertEqual((await asyncio.to_thread(self._http, "GET", "/pair", None, arrived))[0], 200, site)
        framed = {**owner, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe"}
        fetched = {**owner, "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}
        odd = {**owner, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "document"}
        prefetched = {**owner, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
                      "Sec-Purpose": "prefetch"}
        for headers in (framed, fetched, odd, prefetched):
            self.assertEqual((await asyncio.to_thread(self._http, "GET", "/pair", None, headers))[0], 403, headers)

    async def test_the_gateway_gets_the_head_token_and_the_callers_access_assertion(self):
        async with connect(self.url, additional_headers={**self.phone, "Cf-Access-Jwt-Assertion": "signed"}) as ws:
            await asyncio.wait_for(ws.recv(), 10)
        self.assertEqual(FakeGateway.seen[0], ("Bearer right", "signed"))

    async def test_only_verified_owner_gets_lab_access(self):
        from dataclasses import replace
        lab_token = self.dir / "lab-token"
        lab_token.write_text("bridge-lab-test")
        config = replace(self.config, tier="personal", lab_token_file=str(lab_token))
        granted = self.devices.add("Locally granted owner", "parker")
        import hashlib
        self.devices.verify_owner(hashlib.sha256(granted.encode()).hexdigest()[:12], "parker", "Known owner phone")
        tokens = [
            (self.devices.add("SSO owner", "parker", identity_verified=True), "personal", "bridge-lab-test"),
            (granted, "personal", "bridge-lab-test"),
            (self.devices.add("Other signed-in user", "other", identity_verified=True), "guest", ""),
            (self.devices.add("Shared owner link", "parker"), "guest", ""),
        ]
        async def accepted(ws):
            await ws.send("admitted")
        server = await janet_phone.serve(accepted, "127.0.0.1", 0,
            process_request=lambda ws, request: janet_phone.admit(ws, request, config, self.devices))
        try:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1/call"
            for token, tier, credential in tokens:
                # A supplied identity header from the phone is ignored; only its device registry counts.
                async with connect(url, additional_headers={"Authorization": "Bearer " + token, "X-Janet-Lab-Token": "forged"}) as ws:
                    self.assertEqual(await ws.recv(), "admitted")
                self.assertEqual(FakeGateway.calls[-1][1]["tier"], tier)
                self.assertEqual(FakeGateway.lab_tokens[-1], credential)
        finally:
            server.close()
            await server.wait_closed()

    async def test_without_the_lab_gate_the_configured_tier_is_preserved(self):
        from dataclasses import replace
        config = replace(self.config, tier="personal")
        async def accepted(ws):
            await ws.send("admitted")
        server = await janet_phone.serve(accepted, "127.0.0.1", 0,
            process_request=lambda ws, request: janet_phone.admit(ws, request, config, self.devices))
        try:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1/call"
            async with connect(url, additional_headers=self.phone) as ws:
                self.assertEqual(await ws.recv(), "admitted")
            self.assertEqual(FakeGateway.calls[-1][1]["tier"], "personal")
            self.assertEqual(FakeGateway.lab_tokens[-1], "")
        finally:
            server.close()
            await server.wait_closed()

    async def test_two_authorization_headers_are_refused(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.server.sockets[0].getsockname()[1])
        writer.write(b"GET /v1/call HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     b"Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n"
                     b"Authorization: Bearer nope\r\nAuthorization: " + self.phone["Authorization"].encode() + b"\r\n\r\n")
        status = await asyncio.wait_for(reader.readline(), 10)
        writer.close()
        self.assertIn(b"403", status)
        self.assertEqual(FakeGateway.calls, [])

    async def test_a_phone_pairs_with_the_page_code_once_and_can_then_call(self):
        owner = {"X-authentik-username": "parker", "X-Janet-Pair-Proxy": "from-the-proxy"}
        status, page = await asyncio.to_thread(self._http, "GET", "/pair", None, owner)
        self.assertEqual(status, 200)
        self.assertIn("<svg", page)
        link = re.search(r'href="(janetcall://pair\?u=[^"]+)"', page)[1]
        encoded = link.split("u=")[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        self.assertEqual(sorted(payload), ["code", "expires", "url"])
        self.assertEqual(payload["url"], "wss://bridge.example/v1/call")
        self.assertNotIn("s3cret", page)
        paired = {"code": payload["code"], "name": "Galaxy S23"}
        status, body = await asyncio.to_thread(self._http, "POST", "/v1/call/pair", paired)
        self.assertEqual(status, 200)
        self.assertEqual(sorted(json.loads(body)), ["cf_id", "cf_secret", "token"])
        self.assertEqual((json.loads(body)["cf_id"], json.loads(body)["cf_secret"]), ("id.access", "s3cret"))
        self.assertNotIn("right", body)
        self.assertEqual(self.announced, [("Galaxy S23", "parker")])
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", paired))[0], 403)
        async with connect(self.url, additional_headers={"Authorization": "Bearer " + json.loads(body)["token"]}) as ws:
            await asyncio.wait_for(ws.recv(), 10)
        self.assertIn("the device named 'Galaxy S23'", await self._notice())

    async def test_a_link_for_a_chat_message_lands_on_a_page_that_opens_the_app(self):
        owner = {"X-authentik-username": "parker", "X-Janet-Pair-Proxy": "from-the-proxy"}
        status, link = await asyncio.to_thread(self._http, "GET", "/pair?format=link", None, owner)
        self.assertEqual(status, 200)
        link = link.strip()
        self.assertRegex(link, r"^https://bridge\.example/v1/call/pair\?c=[A-Za-z0-9_-]+&e=[0-9]+$")
        self.assertNotIn("s3cret", link)
        self.assertNotIn("id.access", link)
        # Anyone may load the landing page, a chat client's preview included: it spends nothing.
        for _ in range(2):
            status, page = await asyncio.to_thread(self._http, "GET", link.split("bridge.example")[1])
            self.assertEqual(status, 200)
        app = re.search(r'href="(janetcall://pair\?u=[^"]+)"', page)[1].split("u=")[1]
        payload = json.loads(base64.urlsafe_b64decode(app + "=" * (-len(app) % 4)))
        self.assertEqual(sorted(payload), ["code", "expires", "url"])
        self.assertNotIn("s3cret", page)
        status, body = await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": payload["code"], "name": "S23"})
        self.assertEqual((status, json.loads(body)["cf_secret"]), (200, "s3cret"))
        self.assertEqual((await asyncio.to_thread(self._http, "GET", "/v1/call/pair?c=<script>&e=1"))[0], 404)
        self.assertEqual((await asyncio.to_thread(self._http, "GET", "/pair?format=link"))[0], 403)

    async def test_the_pair_exchange_allows_ten_attempts_a_minute(self):
        one = {"Cf-Connecting-Ip": "203.0.113.9"}
        answers = [(await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": "guess"}, one))[0] for _ in range(12)]
        self.assertEqual(answers, [403] * 10 + [429] * 2)
        # Another caller, the owner say, is not locked out by the first.
        other = {"Cf-Connecting-Ip": "198.51.100.7"}
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": "guess"}, other))[0], 403)
        # The landing page is not an attempt.
        self.assertEqual((await asyncio.to_thread(self._http, "GET", "/v1/call/pair?c=" + "a" * 22 + "&e=1"))[0], 200)

    def test_the_limit_forgets_attempts_after_a_minute(self):
        limit = pairing.Limit(2)
        self.assertEqual([limit.allows("a", 0), limit.allows("a", 30), limit.allows("a", 31), limit.allows("b", 31),
                          limit.allows("a", 61), limit.allows("a", 62)], [True, True, False, True, True, False])

    async def test_an_unusable_access_file_refuses_the_exchange_and_keeps_the_code(self):
        code, _ = self.codes.issue("parker")
        good = (self.dir / "access.json").read_text()
        (self.dir / "access.json").write_text("not json")
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": code}))[0], 503)
        self.assertEqual(len(self.devices.listing()), 1)
        (self.dir / "access.json").write_text(good)
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": code}))[0], 200)

    async def test_a_wrong_or_expired_code_pairs_nothing(self):
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": "guess"}))[0], 403)
        code, _ = self.codes.issue("parker", now=time.time() - 301)
        self.assertEqual((await asyncio.to_thread(self._http, "POST", "/v1/call/pair", {"code": code}))[0], 403)
        self.assertEqual(len(self.devices.listing()), 1)


class LevelTest(unittest.TestCase):
    def test_a_level_is_the_rms_of_the_last_20_ms_over_6000_clamped(self):
        quiet, loud = struct.pack("<h", 0), struct.pack("<h", 3000)
        self.assertEqual(janet_phone.level(loud * 320, 16000), 0.5)
        self.assertEqual(janet_phone.level(loud * 480, 24000), 0.5)
        self.assertEqual(janet_phone.level(loud * 1600 + quiet * 320, 16000), 0.0)  # only the last 20 ms counts
        self.assertEqual(janet_phone.level(quiet * 160 + loud * 320, 24000), round((2 / 3) ** 0.5 * 0.5, 3))
        self.assertEqual(janet_phone.level(struct.pack("<h", 30000) * 320, 16000), 1.0)
        self.assertEqual(janet_phone.level(b"", 16000), 0.0)
        self.assertEqual(janet_phone.level(struct.pack("<hh", 3000, -3000) * 160, 16000), 0.5)  # RMS, not the mean

    def test_word_times_start_at_zero_and_end_with_the_audio(self):
        times = janet_phone.word_times("Hi Sam, thanks for calling.", 2.0)
        self.assertEqual([word["w"] for word in times], ["Hi", "Sam,", "thanks", "for", "calling."])
        self.assertEqual(times[0]["t"], 0.0)
        self.assertAlmostEqual(times[-1]["t"] + times[-1]["d"], 2.0, delta=0.02)


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


class NewEndpointerTest(unittest.TestCase):
    def config(self, **kw):
        return janet_phone.Config(listen="x", gateway="x", stt="x", tier="guest", channel="c", disclosure="d", **kw)

    def test_without_models_a_call_uses_the_loudness_rule(self):
        self.assertIsInstance(janet_phone.new_endpointer(self.config()), janet_phone.Endpointer)
        self.assertIsInstance(janet_phone.new_endpointer(self.config(turn_models="/nonexistent")), janet_phone.Endpointer)

    def test_models_that_cannot_load_fall_back_to_the_loudness_rule(self):
        with tempfile.TemporaryDirectory() as models:
            (Path(models) / "silero_vad.onnx").write_text("not a model")
            self.assertIsInstance(janet_phone.new_endpointer(self.config(turn_models=models)), janet_phone.Endpointer)


class LineToneTest(unittest.IsolatedAsyncioTestCase):
    def test_mix_adds_the_tone_to_the_voice_and_clips(self):
        import numpy as np

        voice = np.array([1000, -1000, 32000, -32000], "<i2").tobytes()
        mixed = np.frombuffer(janet_phone.mix(voice, np.array([0.01, 0.01, 0.5, -0.5], np.float32)), "<i2")
        self.assertEqual(mixed.tolist()[2:], [32767, -32768])
        for got, want in zip(mixed.tolist()[:2], [1000 + 327.68, -1000 + 327.68]):
            self.assertAlmostEqual(got, want, delta=1)

    def test_no_code_means_no_line_tone(self):
        config = janet_phone.Config(listen="x", gateway="x", stt="x", tier="guest", channel="c", disclosure="d")
        self.assertIsNone(janet_phone.make_line(config, 24000))

    def test_a_bad_code_is_no_line_tone_and_not_a_failed_call(self):
        config = janet_phone.Config(listen="x", gateway="x", stt="x", tier="guest", channel="c", disclosure="d", line_tone="ZZ9")
        self.assertIsNone(janet_phone.make_line(config, 24000))


if __name__ == "__main__":
    unittest.main()
