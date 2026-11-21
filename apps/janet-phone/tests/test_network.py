import asyncio
import json
import struct
import threading
import time
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

import janet_phone as phone
from opus_transport import Encoder
from speech_stream import PcmSource, SpeechStream
from tests import test_call as fixtures

FakeGateway, tone = fixtures.FakeGateway, fixtures.tone


class GapTest(unittest.TestCase):
    def test_gap_requires_fresh_received_silence_and_keeps_speech(self):
        detector = phone.Endpointer(silence_ms=200)
        self.assertEqual(detector.feed(tone(.2) + bytes(3200)), ["start"])
        detector.gap()
        self.assertEqual(detector.feed(bytes(3840)), [])
        events = detector.feed(tone(.2) + bytes(7040))
        self.assertEqual(len(events), 1)
        self.assertGreaterEqual(len(events[0]), 16000)

    def test_confidence_gate_uses_model_metadata(self):
        self.assertTrue(phone.unreliable_segment({"no_speech_prob": .9}))
        self.assertTrue(phone.unreliable_segment({"avg_logprob": -1.5}))
        self.assertFalse(phone.unreliable_segment({"avg_logprob": -.2, "no_speech_prob": .1}))
        self.assertFalse(phone.unreliable_segment({"text": "any vocabulary"}))


class NetworkTest(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.CallTest.asyncSetUp
    _close = fixtures.CallTest._close
    _until = fixtures.CallTest._until

    async def test_wyoming_confidence_rejects_echo_and_preserves_confident_words(self):
        fixtures.FakeStt.texts = ["recognizer echo", "a confident transcription"]
        fixtures.FakeStt.metadata = {"no_speech_prob": .95, "avg_logprob": -1.5}
        self.assertEqual(await asyncio.to_thread(phone.transcribe, self.config.stt, tone(.3)), "")
        fixtures.FakeStt.metadata = {"no_speech_prob": .05, "avg_logprob": -.2}
        self.assertEqual(await asyncio.to_thread(phone.transcribe, self.config.stt, tone(.3)),
                         "a confident transcription")

    async def test_abrupt_dropout_resumes_one_conversation(self):
        headers = {**self.phone, "X-Janet-Audio": "opus", "X-Janet-Session": "a" * 32}
        first = await connect(self.url, additional_headers=headers)
        self.assertEqual(json.loads(await first.recv())["codec"], "opus")
        await self._until(first, "state")
        first.transport.abort()
        await first.wait_closed()
        async with connect(self.url, additional_headers=headers) as second:
            snapshot = [json.loads(await asyncio.wait_for(second.recv(), 2)) for _ in range(3)]
            self.assertEqual([row["type"] for row in snapshot], ["clear", "audio", "state"])
            self.assertEqual(sum(path == "/v1/conversations" for path, _ in FakeGateway.calls), 1)
            await second.send('{"type":"hangup"}')
        await asyncio.sleep(.1)
        with self.assertRaises(InvalidStatus) as gone:
            async with connect(self.url, additional_headers=headers):
                pass
        self.assertEqual(gone.exception.response.status_code, 410)

    async def test_expired_dropout_ends_head_and_releases_call_slot(self):
        class ShortRecovery(phone.ResumableSocket):
            def __init__(self, socket):
                super().__init__(socket, grace_s=.1)

        with mock.patch.object(phone, "ResumableSocket", ShortRecovery):
            headers = {**self.phone, "X-Janet-Audio": "opus", "X-Janet-Session": "b" * 32}
            ws = await connect(self.url, additional_headers=headers)
            while True:
                event = await ws.recv()
                if isinstance(event, str) and json.loads(event) == {"type": "state", "value": "listening"}:
                    break
            ws.transport.abort()
            await ws.wait_closed()
            for _ in range(100):
                if any(path.endswith("/end") for path, _ in FakeGateway.calls):
                    break
                await asyncio.sleep(.01)
            else:
                self.fail("dropout did not release its head conversation")
            self.assertFalse(phone.OPEN)

    async def test_late_continuation_supersedes_inflight_transcription(self):
        entered, release = threading.Event(), threading.Event()
        captured = []

        def transcribe(address, pcm):
            if not any(pcm):
                return ""
            captured.append(pcm)
            if len(captured) == 1:
                entered.set()
                release.wait(3)
                return "first half"
            return "the complete caller thought"

        with mock.patch.object(phone, "transcribe", side_effect=transcribe):
            async with connect(self.url, additional_headers=self.phone) as ws:
                while True:
                    event = await ws.recv()
                    if isinstance(event, str) and json.loads(event) == {"type": "state", "value": "listening"}:
                        break
                await ws.send(tone(.2) + bytes(7040))
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                await ws.send(tone(.2))
                await asyncio.sleep(.05)
                release.set()
                await ws.send(bytes(7040))
                await self._until(ws, "words")
                await self._until(ws, "words")
        turns = [body["text"] for path, body in FakeGateway.calls if path.endswith("/turns")]
        self.assertEqual(turns, ["the complete caller thought"])
        self.assertGreater(len(captured[-1]), len(captured[0]))

    async def test_stream_sends_first_audio_before_synthesis_finishes(self):
        release, finished = threading.Event(), threading.Event()

        def source():
            yield 24000, tone(.1, 24000)
            release.wait(3)
            finished.set()
            yield 24000, tone(.1, 24000)

        socket = mock.AsyncMock(ring=None)
        socket.audio_codec = "opus"
        call = phone.Call(socket, self.config, mock.Mock(), "0123456789ab")
        stream = SpeechStream(source())
        future = asyncio.get_running_loop().create_future()
        future.set_result(stream)
        task = asyncio.create_task(call.say("A streamed reply.", future, {"endpoint_ms": 200}, time.monotonic()))
        try:
            for _ in range(100):
                if any(isinstance(args.args[0], bytes) for args in socket.send.call_args_list):
                    break
                await asyncio.sleep(.01)
            else:
                self.fail("no audio arrived while synthesis was open")
            self.assertFalse(finished.is_set())
            release.set()
            await asyncio.wait_for(task, 3)
        finally:
            release.set()
            stream.close()
            if call.encoder:
                call.encoder.close()
            call.decoder.close()

    async def test_codec_session_is_validated_before_opening_head(self):
        with self.assertRaises(InvalidStatus):
            async with connect(self.url, additional_headers={**self.phone, "X-Janet-Audio": "opus"}):
                pass
        self.assertEqual(FakeGateway.calls, [])

    async def test_permanently_slower_route_still_delivers_reply(self):
        fixtures.FakeStt.texts = ["the complete thought"]
        encoder = Encoder(16000)
        headers = {**self.phone, "X-Janet-Audio": "opus", "X-Janet-Session": "c" * 32}
        async with connect(self.url, additional_headers=headers) as ws:
            while True:
                message = await ws.recv()
                if isinstance(message, str) and json.loads(message) == {"type": "state", "value": "listening"}:
                    break
            for packet in encoder.encode(tone(.2)):
                await ws.send(packet)
            await asyncio.sleep(.4)

            async def transmit():
                for at in range(0, 16000 * 2 * 4, 640):
                    frame = tone(.02) if at < 6400 else bytes(640)
                    for packet in encoder.encode(frame):
                        await ws.send(packet)
                    await asyncio.sleep(.02)

            sender = asyncio.create_task(transmit())
            try:
                async with asyncio.timeout(4):
                    while True:
                        message = await ws.recv()
                        if isinstance(message, str):
                            event = json.loads(message)
                            if event.get("type") == "words" and event.get("side") == "her":
                                break
            finally:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)
                encoder.close()


class CancellationTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_unblocks_http_read_and_next_synthesis(self):
        blocked, release = threading.Event(), threading.Event()
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["content-length"]))
                requests.append(self.path)
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(struct.pack(">II", 24000, 480) + bytes(480))
                self.wfile.flush()
                if len(requests) == 1:
                    self.wfile.write(struct.pack(">II", 24000, 480))
                    self.wfile.flush()
                    blocked.set()
                    release.wait(5)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        first = SpeechStream(PcmSource(f"http://127.0.0.1:{server.server_port}/tts", {}, {"text": "first"}))
        try:
            await asyncio.wait_for(first.__anext__(), 2)
            self.assertTrue(await asyncio.to_thread(blocked.wait, 2))
            first.close()
            await asyncio.wait_for(asyncio.shield(first.task), 2)
            self.assertFalse(release.is_set())
            second = SpeechStream(PcmSource(f"http://127.0.0.1:{server.server_port}/tts", {}, {"text": "next"}))
            self.assertEqual([chunk async for chunk in second], [(24000, bytes(480))])
            await second.task
        finally:
            first.close()
            release.set()
            await asyncio.to_thread(server.shutdown)
            server.server_close()
