import http.client
import io
from contextlib import closing
import json
import threading
import time
import unittest
from unittest import mock
from http.server import ThreadingHTTPServer

from janet_voice_gateway import Handler, Voice
from tests.fakes import FakeVoice, MAC, TOKEN


class TimingTest(unittest.TestCase):
    def test_first_sample_is_logged_before_a_slow_or_failed_remainder(self):
        for fail in (False, True):
            handler = object.__new__(Handler)
            handler.voice = mock.Mock()
            handler.voice.open.return_value.wav.return_value = bytes(64)
            handler.wfile = io.BytesIO()
            handler._start_stream = mock.Mock()
            chunks = []
            def chunk(data):
                chunks.append(data)
                if len(chunks) == 2:
                    time.sleep(.15)
                    if fail:
                        raise OSError("closed after the first sample")
            handler._chunk = chunk
            began = time.monotonic()
            with self.assertLogs(level="INFO") as captured:
                handler._tts(b'{"text":"a sentence"}')
            rows = [json.loads(record.getMessage()) for record in captured.records]
            first = next(row for row in rows if row["event"] == "tts_first_http_audio_sent")
            self.assertEqual(len(chunks[0]), 46)
            self.assertLess(first["elapsed_ms"], 100)
            self.assertGreaterEqual(time.monotonic() - began, .15)
            self.assertEqual(any(row["event"] == "tts_failed" for row in rows), fail)

    def test_empty_pcm_does_not_claim_audio_sent(self):
        handler = object.__new__(Handler)
        handler.voice = mock.Mock()
        handler.voice.open.return_value.wav.return_value = bytes(44)
        handler.wfile = io.BytesIO()
        handler._start_stream = mock.Mock()
        handler._chunk = mock.Mock()
        with self.assertLogs(level="INFO") as captured:
            handler._tts(b'{"text":"a sentence"}')
        self.assertEqual([json.loads(record.getMessage())["event"] for record in captured.records], ["tts_request"])

    def request(self, metadata, fail=False):
        voice = FakeVoice(fail_after_first_chunk=fail)
        voice.delays["private canary"] = 0.12
        voice.chunk_delay = 0.12
        host, _, port = voice.address.rpartition(":")
        handler = type("TestHandler", (Handler,), {"voice": Voice(host, int(port), "janet", bytes.fromhex(MAC.replace(":", "")), ("127.0.0.1", 9)),
                                                  "token": TOKEN, "access": None})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with self.assertLogs(level="INFO") as captured:
                with closing(http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as client:
                    client.request("POST", "/v1/tts", json.dumps({"text": "private canary", **metadata}),
                                   {"Authorization": "Bearer " + TOKEN})
                    response = client.getresponse()
                    if fail:
                        with self.assertRaises(http.client.IncompleteRead):
                            response.read()
                    else:
                        self.assertEqual(response.read()[44:], b"privatecanary")
                server.shutdown()
            records = [json.loads(r.getMessage()) for r in captured.records if r.getMessage().startswith('{"event":')]
            self.assertNotIn("private canary", json.dumps(records))
            return records
        finally:
            server.server_close()
            voice.shutdown()
            voice.server_close()

    def test_first_wyoming_audio_precedes_buffered_http_audio(self):
        rows = self.request({"conversation_id": "0123456789ab", "turn": 2})
        self.assertEqual([r["event"] for r in rows], ["tts_request", "tts_first_wyoming_audio", "tts_first_http_audio_sent"])
        self.assertGreaterEqual(rows[1]["elapsed_ms"], 100)
        self.assertGreaterEqual(rows[2]["elapsed_ms"] - rows[1]["elapsed_ms"], 100)
        self.assertTrue(all(r["conversation_id"] == "0123456789ab" and r["turn"] == 2 and r["at"] > 0 for r in rows))
        self.assertEqual(len({r["request_id"] for r in rows}), 1)

    def test_legacy_or_invalid_metadata_is_not_invented_or_logged(self):
        for metadata in ({}, {"conversation_id": "private canary", "turn": "private canary"}):
            rows = self.request(metadata)
            self.assertTrue(all(r["conversation_id"] is None and r["turn"] is None for r in rows))

    def test_failed_synthesis_never_claims_http_audio_was_sent(self):
        rows = self.request({}, fail=True)
        self.assertEqual([r["event"] for r in rows], ["tts_request", "tts_first_wyoming_audio", "tts_failed"])
