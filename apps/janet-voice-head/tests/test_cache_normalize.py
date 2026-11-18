import json
import tempfile
import threading
import time
import unittest
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from janet_voice_head import cache_normalize


def tool(name: str, description: str = "d", **extra) -> dict:
    return {"name": name, "description": description, "input_schema": {"type": "object"}, **extra}


MAIN = {"tools": [tool("Bash"), tool("Monitor", "cap 1800000ms", eager_input_streaming=True), tool("EndConversation"), tool("Read")]}


class NormalizeTest(unittest.TestCase):
    def test_a_shared_tool_is_worded_as_main_words_it_without_the_keys_the_fork_does_not_send(self):
        body = {"tools": [tool("Bash"), tool("Monitor", "cap 600000ms")], "messages": []}
        result, note = cache_normalize.normalize(body, MAIN)
        self.assertEqual(result["tools"][1], tool("Monitor", "cap 1800000ms"))
        self.assertNotIn("eager_input_streaming", result["tools"][1])
        self.assertIn("1 tool definitions", note)

    def test_no_tool_is_added_removed_or_reordered(self):
        body = {"tools": [tool("Read"), tool("Monitor", "cap 600000ms"), tool("Bash")]}
        result, _ = cache_normalize.normalize(body, MAIN)
        self.assertEqual([t["name"] for t in result["tools"]], ["Read", "Monitor", "Bash"])

    def test_a_tool_main_does_not_have_stays_as_the_fork_wrote_it(self):
        body = {"tools": [tool("Voice", "mine"), tool("Monitor", "cap 600000ms")]}
        result, _ = cache_normalize.normalize(body, MAIN)
        self.assertEqual(result["tools"][0], tool("Voice", "mine"))

    def test_a_tool_whose_keys_differ_beyond_the_known_one_is_left_alone(self):
        body = {"tools": [tool("Monitor", "cap 600000ms", strict=True)]}
        result, note = cache_normalize.normalize(body, MAIN)
        self.assertIs(result, body)
        self.assertIn("nothing to change", note)

    def test_everything_but_the_tools_is_untouched(self):
        body = {"tools": [tool("Monitor", "cap 600000ms")], "messages": [{"role": "user", "content": "hi"}], "system": [{"type": "text", "text": "s"}], "model": "m"}
        result, _ = cache_normalize.normalize(body, MAIN)
        self.assertEqual({k: v for k, v in result.items() if k != "tools"}, {k: v for k, v in body.items() if k != "tools"})

    def test_a_body_without_tools_or_with_odd_tools_is_returned_as_it_came(self):
        for body in ({"messages": []}, {"tools": []}, {"tools": ["x"]}, {"tools": [{"nope": 1}]}):
            result, note = cache_normalize.normalize(body, MAIN)
            self.assertIs(result, body)
            self.assertIn("skipped", note)


class FakeAnthropic(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _Upstream)
        self.seen: list[tuple[str, dict, bytes]] = []
        self.release = threading.Event()
        threading.Thread(target=self.serve_forever, daemon=True).start()


class _Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.seen.append((self.path, dict(self.headers), body))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for piece in (b"event: one\n\n", b"event: two\n\n"):
            self.wfile.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
            self.wfile.flush()
            if piece.endswith(b"one\n\n"):
                self.server.release.wait(5)
        self.wfile.write(b"0\r\n\r\n")


def shape_transcript(directory: Path, shape: dict) -> Path:
    path = directory / "main.jsonl"
    path.write_text(json.dumps({"type": "user"}) + "\n" + json.dumps({"type": "api-request-shape", "shape": shape}, separators=(",", ":")) + "\n" + json.dumps({"type": "user"}) + "\n")
    return path


class ProxyTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.upstream = FakeAnthropic()
        self.upstream.release.set()
        self.addCleanup(self.upstream.shutdown)
        self.transcript = shape_transcript(self.dir, MAIN)
        self.proxy = cache_normalize.serve_in_background(lambda: self.transcript, upstream=f"http://127.0.0.1:{self.upstream.server_address[1]}")
        self.addCleanup(self.proxy.shutdown)

    def post(self, path: str, body: bytes) -> http.client.HTTPResponse:
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_address[1], timeout=10)
        connection.request("POST", path, body, {"content-type": "application/json", "authorization": "Bearer secret", "anthropic-beta": "b1"})
        return connection.getresponse()

    def test_a_messages_request_reaches_the_upstream_with_main_s_wording_and_the_caller_s_headers(self):
        body = json.dumps({"tools": [tool("Monitor", "cap 600000ms")], "messages": []}).encode()
        self.assertEqual(self.post("/v1/messages?beta=true", body).status, 200)
        path, headers, sent = self.upstream.seen[0]
        self.upstream.release.set()
        self.assertEqual(path, "/v1/messages?beta=true")
        self.assertEqual(json.loads(sent)["tools"][0]["description"], "cap 1800000ms")
        self.assertEqual((headers["authorization"], headers["anthropic-beta"]), ("Bearer secret", "b1"))

    def test_the_reply_streams_back_before_the_upstream_has_finished(self):
        self.upstream.release.clear()
        response = self.post("/v1/messages", json.dumps({"tools": [tool("Monitor", "x")]}).encode())
        self.assertEqual(response.read(12), b"event: one\n\n")
        self.upstream.release.set()
        self.assertIn(b"event: two", response.read())

    def test_a_body_that_is_not_json_goes_through_unchanged(self):
        self.post("/v1/messages", b"not json").read()
        self.upstream.release.set()
        self.assertEqual(self.upstream.seen[0][2], b"not json")
        self.assertIn("skipped", self.proxy.notes[-1])

    def test_without_a_reference_the_request_goes_through_unchanged(self):
        self.transcript.write_text(json.dumps({"type": "user"}) + "\n")
        body = json.dumps({"tools": [tool("Monitor", "cap 600000ms")]}).encode()
        self.post("/v1/messages", body).read()
        self.upstream.release.set()
        self.assertEqual(self.upstream.seen[0][2], body)

    def test_a_chunked_or_malformed_length_request_is_refused_and_the_reply_has_one_server_and_date_header(self):
        for headers in ({"Transfer-Encoding": "chunked"}, {"Content-Length": "abc"}):
            connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_address[1], timeout=10)
            connection.putrequest("POST", "/v1/messages", skip_accept_encoding=True)
            for key, value in headers.items():
                connection.putheader(key, value)
            connection.endheaders()
            self.assertEqual(connection.getresponse().status, 400)
        self.assertEqual(self.upstream.seen, [])
        reply = self.post("/v1/messages", b"{}")
        self.assertEqual(len([k for k, _ in reply.getheaders() if k.lower() in ("server", "date")]), 2)
        reply.read()

    def test_other_endpoints_are_not_touched(self):
        body = json.dumps({"tools": [tool("Monitor", "cap 600000ms")]}).encode()
        self.post("/v1/messages/count_tokens", body).read()
        self.upstream.release.set()
        self.assertEqual(self.upstream.seen[0][2], body)

    def test_the_last_logged_shape_wins_and_a_torn_line_is_ignored(self):
        older = {"tools": [tool("Monitor", "old")]}
        self.transcript.write_text(json.dumps({"type": "api-request-shape", "shape": older}, separators=(",", ":")) + "\n"
                                   + json.dumps({"type": "api-request-shape", "shape": MAIN}, separators=(",", ":")) + "\n"
                                   + '{"type":"api-request-shape","shape":{"tools":[')
        self.assertEqual(cache_normalize.last_shape(self.transcript), MAIN)


if __name__ == "__main__":
    unittest.main()
