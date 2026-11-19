import asyncio
import json
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK, InvalidStatus

from janet_dictate import CHUNK_BYTES, PCM_TYPE, Config, Dictation

TOKEN = "a-test-credential-with-at-least-32-characters"


class Decoder:
    def fresh(self):
        return Decoder()

    def __call__(self, chunk):
        return ([("▁hello", 0.0)] if chunk.any() else []), False


class DictationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = Dictation(Config(Path("."), TOKEN, max_sessions=2, max_seconds=3, idle_seconds=1), Decoder())
        self.server = await serve(
            self.app.handle,
            "127.0.0.1",
            0,
            process_request=self.app.authorize,
            max_size=32000,
            max_queue=4,
            compression=None,
            close_timeout=1,
        )
        self.base = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.assertEqual(self.app.active, 0)

    def url(self, **query):
        return (
            self.base
            + "/client/ws/speech?"
            + urlencode(
                {
                    "key": TOKEN,
                    "content-type": PCM_TYPE,
                    "lang": "en-US",
                    "partial": "true",
                    **query,
                }
            )
        )

    async def test_live_composition_then_final_and_clean_close(self):
        async with connect(self.url()) as ws:
            await ws.send(b"\x01\x00" * (CHUNK_BYTES // 2))
            partial = json.loads(await ws.recv())
            self.assertEqual(
                partial,
                {
                    "status": 0,
                    "result": {
                        "hypotheses": [{"transcript": "hello"}],
                        "final": False,
                    },
                },
            )
            await ws.send(b"\x01\x00" * (CHUNK_BYTES // 2))
            self.assertEqual(json.loads(await ws.recv())["result"]["hypotheses"][0]["transcript"], "hello hello")
            await ws.send("EOS")
            final = json.loads(await ws.recv())
            self.assertTrue(final["result"]["final"])
            self.assertEqual(final["result"]["hypotheses"][0]["transcript"], "hello hello")
            with self.assertRaises(ConnectionClosedOK):
                await ws.recv()

    async def test_tail_and_odd_frame_boundaries_are_preserved(self):
        async with connect(self.url()) as ws:
            await ws.send(b"\x01")
            await ws.send(b"\x00")
            await ws.send("EOS")
            final = json.loads(await ws.recv())
            self.assertTrue(final["result"]["final"])
            self.assertEqual(final["result"]["hypotheses"][0]["transcript"], "hello")

    async def test_stock_konele_handshake(self):
        async with connect(
            self.url(),
            compression=None,
            additional_headers={"Sec-WebSocket-Protocol": "", "Sec-WebSocket-Extensions": "x-webkit-deflate-frame"},
        ) as ws:
            self.assertIsNone(ws.subprotocol)
            await ws.send(b"\x01\x00" * (CHUNK_BYTES // 2))
            self.assertFalse(json.loads(await ws.recv())["result"]["final"])
            await ws.send("EOS")
            self.assertTrue(json.loads(await ws.recv())["result"]["final"])

    async def test_invalid_pcm_and_control_frames(self):
        for messages in (["EOS"], [b"\x00", "EOS"], ["stop"]):
            with self.subTest(messages=messages):
                async with connect(self.url()) as ws:
                    for message in messages:
                        await ws.send(message)
                    self.assertEqual(json.loads(await ws.recv()), {"status": 5})
                    with self.assertRaises(ConnectionClosedOK):
                        await ws.recv()

    async def test_silence_has_no_hallucinated_final(self):
        async with connect(self.url()) as ws:
            await ws.send(bytes(CHUNK_BYTES))
            await ws.send("EOS")
            self.assertEqual(json.loads(await ws.recv()), {"status": 1})

    async def test_auth_and_format_rejected_before_decoder_session(self):
        cases = [
            (self.url(key="wrong"), {}, 401),
            (self.url(key=""), {}, 401),
            (self.url() + "&key=" + TOKEN, {}, 401),
            (self.url(**{"content-type": "audio/x-flac"}), {}, 400),
            (self.url(lang="et"), {}, 400),
            (self.url().replace("/speech?", "/unknown?"), {}, 404),
            (self.url(), {"origin": "https://example.com"}, 403),
        ]
        for url, options, status in cases:
            with self.subTest(status=status):
                with self.assertRaises(InvalidStatus) as caught:
                    async with connect(url, **options):
                        self.fail("unexpected upgrade")
                self.assertEqual(caught.exception.response.status_code, status)
                self.assertEqual(self.app.active, 0)

    async def test_session_limit_is_released_after_disconnect(self):
        async with connect(self.url()) as first, connect(self.url()) as second:
            async with connect(self.url()) as extra:
                self.assertEqual(json.loads(await extra.recv()), {"status": 9})
            await first.close()
            await second.send(bytes(CHUNK_BYTES))
            await asyncio.sleep(0.02)
            async with connect(self.url()) as replacement:
                await replacement.send(b"\x01\x00" * (CHUNK_BYTES // 2))
                self.assertEqual(json.loads(await replacement.recv())["status"], 0)

    async def test_sessions_do_not_share_transcripts(self):
        async with connect(self.url()) as first, connect(self.url()) as second:
            await first.send(b"\x01\x00" * (CHUNK_BYTES // 2))
            await first.recv()
            await second.send(bytes(CHUNK_BYTES))
            await second.send("EOS")
            self.assertEqual(json.loads(await second.recv()), {"status": 1})
            await first.send("EOS")
            self.assertEqual(json.loads(await first.recv())["result"]["hypotheses"][0]["transcript"], "hello")

    async def test_idle_and_audio_duration_limits(self):
        async with connect(self.url()) as ws:
            self.assertEqual(json.loads(await ws.recv()), {"status": 2})
        async with connect(self.url()) as ws:
            for _ in range(4):
                await ws.send(bytes(32000))
            self.assertEqual(json.loads(await ws.recv()), {"status": 2})

    async def test_oversize_frame_closes_connection(self):
        async with connect(self.url()) as ws:
            await ws.send(bytes(32001))
            with self.assertRaises(ConnectionClosedError) as caught:
                await ws.recv()
            self.assertEqual(caught.exception.rcvd.code, 1009)

    async def test_decoder_failure_releases_slot(self):
        class Broken(Decoder):
            def fresh(self):
                raise RuntimeError("unavailable")

        self.app.words = Broken()
        with self.assertLogs("janet-dictate", level="ERROR"):
            async with connect(self.url()) as ws:
                with self.assertRaises(ConnectionClosedError) as caught:
                    await ws.recv()
                self.assertEqual(caught.exception.rcvd.code, 1011)

    async def test_timed_out_inference_keeps_its_slot_until_the_worker_finishes(self):
        release = threading.Event()

        class Slow(Decoder):
            def fresh(self):
                return self

            def __call__(self, chunk):
                release.wait(5)
                return super().__call__(chunk)

        self.app.words = Slow()
        self.app.config = Config(Path("."), TOKEN, max_sessions=1, max_seconds=1)
        try:
            async with connect(self.url()) as ws:
                await ws.send(bytes(CHUNK_BYTES))
                self.assertEqual(json.loads(await ws.recv()), {"status": 2})
                async with connect(self.url()) as extra:
                    self.assertEqual(json.loads(await extra.recv()), {"status": 9})
                release.set()
                with self.assertRaises(ConnectionClosedOK):
                    await ws.recv()
        finally:
            release.set()


if __name__ == "__main__":
    unittest.main()
