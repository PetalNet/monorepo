import http.client
from contextlib import closing
import json
import threading
import unittest
from http.server import ThreadingHTTPServer

from janet_voice_gateway import Handler, Voice
from tests.fakes import FakeVoice, MAC, TOKEN


class TimingTest(unittest.TestCase):
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
