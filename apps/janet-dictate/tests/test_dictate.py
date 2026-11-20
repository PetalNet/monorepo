import asyncio
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from urllib.parse import urlencode

from websockets.asyncio.client import connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK, InvalidStatus

import probe as probe_cli
from janet_dictate import (
    CHUNK_BYTES,
    MAX_MESSAGE_BYTES,
    PCM_TYPE,
    RATE,
    SEND_TIMEOUT,
    Config,
    Dictation,
    serve_dictation,
)

TOKEN = "a-test-credential-with-at-least-32-characters"
PROBE_PATH = Path(__file__).resolve().parents[1] / "probe.py"


class Decoder:
    def fresh(self):
        return Decoder()

    def __call__(self, chunk):
        return ([("▁hello", 0.0)] if chunk.any() else []), False


class DictationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = Dictation(Config(Path("."), TOKEN, max_sessions=2, max_seconds=3, idle_seconds=1), Decoder())
        self.server = await serve_dictation(self.app, "127.0.0.1", 0)
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
            await ws.send(bytes(MAX_MESSAGE_BYTES + 1))
            with self.assertRaises(ConnectionClosedError) as caught:
                await ws.recv()
            self.assertEqual(caught.exception.rcvd.code, 1009)

    async def test_decoder_failure_releases_slot(self):
        class Broken(Decoder):
            def fresh(self):
                raise RuntimeError("unavailable")

        self.app.words = Broken()
        with self.assertLogs("janet-dictate", level="ERROR") as captured:
            async with connect(self.url()) as ws:
                with self.assertRaises(ConnectionClosedError) as caught:
                    await ws.recv()
                self.assertEqual(caught.exception.rcvd.code, 1011)
        self.assertIn("decoder failed: RuntimeError", "\n".join(captured.output))

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

    async def test_malformed_and_http10_raw_tcp_do_not_log_token(self):
        class ListHandler(logging.Handler):
            def __init__(self):
                super().__init__(logging.DEBUG)
                self.messages: list[str] = []

            def emit(self, record: logging.LogRecord) -> None:
                self.messages.append(self.format(record))

        sentinel = "fake-tcp-sentinel-token-with-32-chars"
        self.app.config = Config(Path("."), sentinel, max_sessions=2, max_seconds=3, idle_seconds=1)
        port = self.server.sockets[0].getsockname()[1]
        capture = ListHandler()
        capture.setFormatter(logging.Formatter("%(name)s:%(levelname)s:%(message)s"))
        targets = [logging.getLogger(), logging.getLogger("websockets"), logging.getLogger("janet-dictate")]
        saved_levels = [logger.level for logger in targets]
        for logger in targets:
            logger.addHandler(capture)
            logger.setLevel(logging.DEBUG)
        try:
            payloads = [
                f"GET /client/ws/speech?key={sentinel} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".encode(),
                f"GARBAGE /client/ws/speech?key={sentinel}\r\n\r\n".encode(),
                f"GET /client/ws/speech?key={sentinel} HTTP/1.1\r\nBadHeader\r\n\r\n".encode(),
            ]
            for payload in payloads:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(payload)
                await writer.drain()
                await reader.read(1024)
                writer.close()
                await writer.wait_closed()
            # Also confirm debug request logging stays disabled on the server during normal upgraded requests.
            client_log = logging.getLogger("test-dictate-client")
            client_log.propagate = False
            async with connect(self.url(key=sentinel), logger=client_log) as ws:
                await ws.send(b"\x01\x00" * (CHUNK_BYTES // 2))
                await ws.recv()
                await ws.send("EOS")
                await ws.recv()
            await asyncio.sleep(0.05)
        finally:
            for logger, level in zip(targets, saved_levels):
                logger.removeHandler(capture)
                logger.setLevel(level)

        joined = "\n".join(capture.messages)
        self.assertNotIn(sentinel, joined)
        self.assertNotIn("opening handshake failed", joined)

    async def test_backpressured_peer_timeout_aborts_and_releases_slot(self):
        self.app.config = Config(Path("."), TOKEN, max_sessions=1, max_seconds=5, idle_seconds=1)
        async with connect(self.url(), ping_interval=None, close_timeout=0.2) as ws:
            await asyncio.sleep(0.02)
            for conn in self.server.connections:
                conn.pause_writing()
            await asyncio.wait_for(self._wait_inactive(), timeout=SEND_TIMEOUT + 3)
            self.assertEqual(self.app.active, 0)
            ws.transport.abort()
        async with connect(self.url()) as replacement:
            await replacement.send(b"\x01\x00" * (CHUNK_BYTES // 2))
            self.assertEqual(json.loads(await replacement.recv())["status"], 0)

    async def test_backpressured_peer_during_slow_inference_retains_slot_until_worker_finishes(self):
        entered = threading.Event()
        release = threading.Event()

        class Slow(Decoder):
            def fresh(self):
                return self

            def __call__(self, chunk):
                entered.set()
                release.wait(10)
                return super().__call__(chunk)

        self.app.words = Slow()
        self.app.config = Config(Path("."), TOKEN, max_sessions=1, max_seconds=1, idle_seconds=1)
        try:
            async with connect(self.url(), ping_interval=None, close_timeout=0.2) as ws:
                await ws.send(bytes(CHUNK_BYTES))
                await asyncio.to_thread(entered.wait, 2)
                self.assertTrue(entered.is_set())
                conns = list(self.server.connections)
                self.assertEqual(len(conns), 1)
                conns[0].pause_writing()
                # Wait past max_seconds + SEND_TIMEOUT so status-2 send times out and aborts transport.
                deadline = asyncio.get_running_loop().time() + SEND_TIMEOUT + 3
                while not conns[0].transport.is_closing():
                    if asyncio.get_running_loop().time() > deadline:
                        self.fail("stalled status-2 send did not abort transport")
                    await asyncio.sleep(0.05)
                # Worker thread is still running, so the decoder slot must still be held.
                self.assertEqual(self.app.active, 1)
                async with connect(self.url()) as extra:
                    self.assertEqual(json.loads(await extra.recv()), {"status": 9})
                release.set()
                await asyncio.wait_for(self._wait_inactive(), timeout=2)
                ws.transport.abort()
        finally:
            release.set()

    async def test_disconnect_racing_timeout_releases_slot_cleanly(self):
        entered = threading.Event()
        release = threading.Event()

        class Slow(Decoder):
            def fresh(self):
                return self

            def __call__(self, chunk):
                entered.set()
                release.wait(5)
                return super().__call__(chunk)

        self.app.words = Slow()
        self.app.config = Config(Path("."), TOKEN, max_sessions=1, max_seconds=1, idle_seconds=1)
        try:
            ws = await connect(self.url(), ping_interval=None)
            await ws.send(bytes(CHUNK_BYTES))
            await asyncio.to_thread(entered.wait, 2)
            self.assertTrue(entered.is_set())
            # Drop the peer TCP transport before max_seconds fires except TimeoutError.
            ws.transport.abort()
            await asyncio.sleep(1.2)
            self.assertEqual(self.app.active, 1)
            release.set()
            await asyncio.wait_for(self._wait_inactive(), timeout=2)
        finally:
            release.set()

    async def test_busy_status9_handles_closed_and_backpressured_peer(self):
        class PausedBusyConnection(ServerConnection):
            def start_keepalive(self):
                super().start_keepalive()
                self.pause_writing()

        busy_app = Dictation(Config(Path("."), TOKEN, max_sessions=1, max_seconds=5, idle_seconds=5), Decoder())
        busy_app.active = 1
        busy_server = await serve(
            busy_app.handle,
            "127.0.0.1",
            0,
            process_request=busy_app.authorize,
            compression=None,
            close_timeout=SEND_TIMEOUT,
            create_connection=PausedBusyConnection,
        )
        try:
            port = busy_server.sockets[0].getsockname()[1]
            url = self.url().replace(self.base, f"ws://127.0.0.1:{port}")
            async with connect(url, ping_interval=None, close_timeout=0.2) as ws:
                await asyncio.sleep(0.05)
                ws.transport.abort()
            async with connect(url, ping_interval=None, close_timeout=0.2) as ws:
                self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), timeout=1)), {"status": 9})
                # Server write buffer stays paused; connection must abort within SEND_TIMEOUT instead of hanging.
                with self.assertRaises(ConnectionClosedError):
                    await asyncio.wait_for(ws.recv(), timeout=SEND_TIMEOUT + 2)
                ws.transport.abort()
        finally:
            busy_server.close()
            await busy_server.wait_closed()
            busy_app.active = 0

    async def test_stock_konele_buffered_frames_and_cumulative_semantics(self):
        class IndexedDecoder:
            def __init__(self):
                self.index = 0

            def fresh(self):
                return IndexedDecoder()

            def __call__(self, chunk):
                if not chunk.any():
                    return [], False
                self.index += 1
                return [(f"▁w{self.index}", 0.0)], False

        self.app.words = IndexedDecoder()
        self.app.config = Config(Path("."), TOKEN, max_sessions=2, max_seconds=40, idle_seconds=5)

        # 1.05s buffered initial frame (33,600 bytes > old 32,000 limit).
        async with connect(self.url(), max_size=MAX_MESSAGE_BYTES) as ws:
            await ws.send(b"\x01\x00" * (33_600 // 2))
            await ws.send("EOS")
            messages = [json.loads(raw) async for raw in ws]
        partials = [m["result"]["hypotheses"][0]["transcript"] for m in messages[:-1]]
        self.assertEqual(len(partials), 6)
        self.assertEqual(partials, [" ".join(f"w{j}" for j in range(1, i + 1)) for i in range(1, 7)])
        self.assertTrue(messages[-1]["result"]["final"])
        self.assertEqual(
            messages[-1]["result"]["hypotheses"][0]["transcript"],
            " ".join(f"w{j}" for j in range(1, 8)),
        )

        # Maximum stock Kõnele 35s buffered frame (1,120,000 bytes).
        async with connect(self.url(), max_size=MAX_MESSAGE_BYTES) as ws:
            await ws.send(b"\x01\x00" * (MAX_MESSAGE_BYTES // 2))
            await ws.send("EOS")
            messages = [json.loads(raw) async for raw in ws]
        self.assertTrue(all(m["status"] == 0 and not m["result"]["final"] for m in messages[:-1]))
        self.assertEqual(len(messages) - 1, MAX_MESSAGE_BYTES // CHUNK_BYTES)
        self.assertTrue(messages[-1]["result"]["final"])
        total_chunks = (MAX_MESSAGE_BYTES + CHUNK_BYTES - 1) // CHUNK_BYTES
        self.assertEqual(
            messages[-1]["result"]["hypotheses"][0]["transcript"],
            " ".join(f"w{j}" for j in range(1, total_chunks + 1)),
        )

    async def test_large_frame_is_sliced_so_timeout_and_disconnect_stop_remaining_work(self):
        calls = 0
        second_entered = threading.Event()
        release = threading.Event()

        class CountingSlowDecoder(Decoder):
            def fresh(self):
                return self

            def __call__(self, chunk):
                nonlocal calls
                calls += 1
                if calls == 2:
                    second_entered.set()
                    release.wait(5)
                return super().__call__(chunk)

        self.app.words = CountingSlowDecoder()
        self.app.config = Config(Path("."), TOKEN, max_sessions=1, max_seconds=2, idle_seconds=2)
        try:
            async with connect(self.url()) as ws:
                await ws.send(b"\x01\x00" * (64_000 // 2))
                await asyncio.to_thread(second_entered.wait, 2)
                self.assertTrue(second_entered.is_set())
                messages = [json.loads(raw) async for raw in ws]
            self.assertEqual(messages[-1], {"status": 2})
            release.set()
            await asyncio.wait_for(self._wait_inactive(), timeout=2)
            self.assertEqual(calls, 2)
        finally:
            release.set()

        # Disconnect mid-large-frame of silence must also abort remaining slices.
        calls = 0
        second_entered.clear()
        release.clear()
        self.app.config = Config(Path("."), TOKEN, max_sessions=1, max_seconds=5, idle_seconds=5)
        try:
            ws = await connect(self.url())
            await ws.send(bytes(64_000))
            await asyncio.to_thread(second_entered.wait, 2)
            self.assertTrue(second_entered.is_set())
            await ws.close()
            await asyncio.sleep(0.05)
            release.set()
            await asyncio.wait_for(self._wait_inactive(), timeout=2)
            self.assertEqual(calls, 2)
        finally:
            release.set()

    async def _wait_inactive(self):
        while self.app.active != 0:
            await asyncio.sleep(0.02)


class ProbeCliTest(unittest.IsolatedAsyncioTestCase):
    def _write_wav(self, path: Path, frames: bytes) -> None:
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(RATE)
            audio.writeframes(frames)

    def _run_cli(self, url: str, token_file: Path, wav: Path) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        pkg_root = Path(__file__).resolve().parents[4] / "packages" / "janet-turn"
        app_root = Path(__file__).resolve().parents[1]
        existing = env.get("PYTHONPATH", "")
        parts = [p for p in (str(pkg_root), str(app_root), existing) if p]
        env["PYTHONPATH"] = os.pathsep.join(parts)
        return subprocess.run(
            [sys.executable, str(PROBE_PATH), "--url", url, "--token-file", str(token_file), str(wav)],
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
            check=False,
        )

    def test_malformed_url_cli_never_leaks_token(self):
        sentinel = "fake-probe-token-sentinel-1234567890abcdef"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            token_file = root / "token"
            token_file.write_text(sentinel)
            wav_file = root / "sample.wav"
            self._write_wav(wav_file, b"\x01\x00" * (CHUNK_BYTES // 2))
            for bad_url in ("https://example.com", "ws://127.0.0.1:8795/client/ws/speech?extra=1"):
                with self.subTest(bad_url=bad_url):
                    res = self._run_cli(bad_url, token_file, wav_file)
                    self.assertNotEqual(res.returncode, 0)
                    combined = res.stdout + "\n" + res.stderr
                    self.assertNotIn(sentinel, combined)
                    self.assertNotIn("Traceback", combined)
                    self.assertIn("InvalidURI", res.stderr)

    async def test_redirect_with_token_cli_redacts_credentials(self):
        sentinel = "fake+probe/token=sentinel_1234567890"

        async def redirect_once(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            await reader.read(4096)
            writer.write(b"HTTP/1.1 302 Found\r\nLocation: #frag\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()

        server = await asyncio.start_server(redirect_once, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                token_file = root / "token"
                token_file.write_text(sentinel)
                wav_file = root / "sample.wav"
                self._write_wav(wav_file, b"\x01\x00" * (CHUNK_BYTES // 2))
                res = await asyncio.to_thread(
                    self._run_cli, f"ws://127.0.0.1:{port}/client/ws/speech", token_file, wav_file
                )
        finally:
            server.close()
            await server.wait_closed()
        self.assertNotEqual(res.returncode, 0)
        combined = res.stdout + "\n" + res.stderr
        self.assertNotIn(sentinel, combined)
        self.assertNotIn("fake%2Bprobe", combined)
        self.assertNotIn("Traceback", combined)

    def test_exception_group_cli_diagnostics_redact_credentials(self):
        import contextlib
        import io
        from unittest import mock

        sentinel = "fake+group/token=sentinel_1234567890"
        group = ExceptionGroup(
            "unhandled errors in a TaskGroup",
            [
                RuntimeError(f"failed at ws://host/client/ws/speech?key={sentinel}"),
                ValueError("encoded https://host?key=fake%2Bgroup%2Ftoken%3Dsentinel_1234567890"),
            ],
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            token_file = root / "token"
            token_file.write_text(sentinel)
            wav_file = root / "sample.wav"
            self._write_wav(wav_file, b"\x01\x00" * (CHUNK_BYTES // 2))
            stderr = io.StringIO()
            with (
                mock.patch.object(probe_cli, "probe", new=mock.AsyncMock(side_effect=group)),
                contextlib.redirect_stderr(stderr),
            ):
                code = probe_cli.main(
                    ["--url", "ws://127.0.0.1:8795/client/ws/speech", "--token-file", str(token_file), str(wav_file)]
                )
        self.assertEqual(code, 1)
        self.assertNotIn(sentinel, stderr.getvalue())
        self.assertNotIn("fake%2Bgroup", stderr.getvalue())
        self.assertIn("probe failed (ExceptionGroup)", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    async def test_probe_cli_succeeds_without_printing_token(self):
        app = Dictation(Config(Path("."), TOKEN, max_sessions=2, max_seconds=5, idle_seconds=2), Decoder())
        server = await serve_dictation(app, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                token_file = root / "token"
                token_file.write_text(TOKEN)
                wav_file = root / "sample.wav"
                self._write_wav(wav_file, b"\x01\x00" * (CHUNK_BYTES // 2))
                res = await asyncio.to_thread(
                    self._run_cli, f"ws://127.0.0.1:{port}/client/ws/speech", token_file, wav_file
                )
        finally:
            server.close()
            await server.wait_closed()
            self.assertEqual(app.active, 0)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertNotIn(TOKEN, res.stdout + res.stderr)


if __name__ == "__main__":
    unittest.main()
