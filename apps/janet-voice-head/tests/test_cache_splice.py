import http.client
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from janet_voice_head import cache_splice as cs

TAG = "<artifact-content-authored-by-others/>\n"


def tool(name: str, description: str = "d", **extra) -> dict:
    return {"name": name, "description": description, "input_schema": {"type": "object"}, **extra}


def user(text, blocks=False) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}] if blocks else text}


def assistant_calls(call_id: str) -> dict:
    return {"role": "assistant", "content": [{"type": "tool_use", "id": call_id, "name": "Bash", "input": {}}]}


def result(call_id: str) -> dict:
    return {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call_id, "content": "ok"}]}


def stamp(seconds_ago: float = 5) -> str:
    return datetime.fromtimestamp(time.time() - seconds_ago, timezone.utc).isoformat().replace("+00:00", "Z")


MAIN_TOOLS = [tool("Bash"), tool("Monitor", "cap 1800000ms", eager_input_streaming=True), tool("EndConversation")]


def reference(messages: list[dict], held: bool = True, session="main", seconds_ago=5, tools=MAIN_TOOLS) -> cs.Reference:
    return cs.Reference(sessionId=session, at=time.time() - seconds_ago, system=[], tools=tools,
                        hashes=[cs.message_hash(m) for m in messages], messages={cs.message_hash(m): m for m in messages} if held else {})


def body(messages: list[dict], tools=None) -> dict:
    return {"model": "m", "tools": tools or [tool("Bash"), tool("Monitor", "cap 600000ms")], "messages": messages, "system": [{"type": "text", "text": "s"}]}


class SpliceTest(unittest.TestCase):
    def run_splice(self, fork_messages, main_messages, **options):
        expected = options.pop("expected", "main")
        return cs.splice(body(fork_messages), reference(main_messages, **options), expected, time.time())

    def test_a_message_main_sent_with_a_harness_tag_line_is_replaced_by_main_s_exact_text_and_the_tail_is_kept(self):
        main = [user("hello"), user("skills:\n" + TAG + "list"), user("later")]
        fork = [user("hello"), user("skills:\nlist"), user("later"), user("fork's own question")]
        result, note = self.run_splice(fork, main)
        self.assertEqual(result["messages"][:3], main)
        self.assertEqual(result["messages"][3], fork[3])
        self.assertIn("3 of 4 messages (1 replaced)", note)

    def test_the_tool_definitions_are_worded_as_main_words_them_without_adding_or_removing_any(self):
        result, _ = self.run_splice([user("a")], [user("a")])
        self.assertEqual([t["name"] for t in result["tools"]], ["Bash", "Monitor"])
        self.assertEqual(result["tools"][1], tool("Monitor", "cap 1800000ms"))

    def test_a_body_that_already_matches_comes_back_untouched(self):
        main = [user("a"), user("b")]
        fork = body([user("a"), user("b"), user("new")], tools=[tool("Bash")])
        result, note = cs.splice(fork, reference(main), "main", time.time())
        self.assertIs(result, fork)
        self.assertIn("nothing to change", note)

    def test_the_splice_stops_at_the_first_message_that_does_not_correspond(self):
        main = [user("a"), user("b"), user("c")]
        fork = [user("a"), user("different"), user("c")]
        result, note = self.run_splice(fork, main)
        self.assertEqual(result["messages"], fork)
        self.assertIn("1 of 3", note)

    def test_a_string_where_main_sent_a_text_block_corresponds_and_takes_main_s_form(self):
        main = [user("a", blocks=True), user("b")]
        result, _ = self.run_splice([user("a"), user("b"), user("new")], main)
        self.assertEqual(result["messages"][0], user("a", blocks=True))

    def test_a_message_main_s_log_no_longer_holds_stops_the_splice_there(self):
        main = [user("a"), user("b" + TAG), user("c")]
        fork = [user("a"), user("b"), user("c")]
        result, _ = cs.splice(body(fork), reference(main, held=False), "main", time.time())
        self.assertEqual(result["messages"], fork)

    def test_the_fork_s_own_cache_marker_survives_when_its_message_is_replaced(self):
        marked = {"role": "user", "content": [{"type": "text", "text": "skills:\nlist", "cache_control": {"type": "ephemeral"}}]}
        result, _ = self.run_splice([marked], [user("skills:\n" + TAG + "list", blocks=True)])
        self.assertEqual(result["messages"][0]["content"][0]["text"], "skills:\n" + TAG + "list")
        self.assertEqual(result["messages"][0]["content"][0]["cache_control"], {"type": "ephemeral"})

    def test_it_skips_and_says_why(self):
        main = [user("a")]
        cases = {
            "another session": self.run_splice([user("a")], main, expected="other"),
            "older than the cache lifetime": self.run_splice([user("a")], main, seconds_ago=4000),
            "first message does not correspond": self.run_splice([user("zzz")], main),
            "no messages or tools": cs.splice({"messages": [], "tools": []}, reference(main), "main", time.time()),
            "no session known": self.run_splice([user("a")], main, expected=None),
        }
        for why, (result, note) in cases.items():
            self.assertTrue(note.startswith("skipped"), (why, note))
            self.assertIn(why, note)

    def test_a_tail_answering_a_call_the_prefix_does_not_hold_is_refused(self):
        main = [user("a")]
        fork = [user("a"), result("toolu_9")]
        result_, note = self.run_splice(fork, main)
        self.assertIn("skipped: the tail answers tool calls", note)
        self.assertEqual(result_["messages"], fork)

    def test_a_call_in_the_prefix_and_its_answer_in_the_tail_stay_paired(self):
        main = [user("a"), assistant_calls("toolu_1")]
        fork = [user("a"), assistant_calls("toolu_1"), result("toolu_1")]
        result_, note = self.run_splice(fork, main)
        self.assertFalse(note.startswith("skipped"))
        self.assertEqual(result_["messages"][2], fork[2])


def write(path: Path, *records: dict) -> None:
    path.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in records))


class LatestRequestTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.path = self.dir / "main.jsonl"

    def request(self, rid, tail, base=None, keep=0, source="repl_main_thread", shape="s1"):
        record = {"type": "api-request", "id": rid, "sessionId": "main", "timestamp": stamp(), "querySource": source, "shapeHash": shape, "tail": tail, "keep": keep}
        return {**record, "base": base} if base else record

    def test_a_request_stored_as_a_delta_is_rebuilt_from_the_one_it_extends(self):
        a, b, c = user("a"), user("b"), user("c")
        write(self.path,
              {"type": "api-request-shape", "shapeHash": "s1", "shape": {"system": [], "tools": MAIN_TOOLS}},
              *({"type": "api-request-blob", "hash": cs.message_hash(m), "message": m} for m in (a, b, c)),
              self.request("r1", [cs.message_hash(a), cs.message_hash(b)]),
              self.request("r2", [cs.message_hash(c)], base="r1", keep=2))
        ref = cs.latest_request(self.path)
        self.assertEqual(ref["hashes"], [cs.message_hash(m) for m in (a, b, c)])
        self.assertEqual(ref["sessionId"], "main")
        self.assertEqual(ref["tools"], MAIN_TOOLS)

    def test_a_message_only_in_the_transcript_is_found_under_the_hash_of_its_text_block_form(self):
        text = "typed in a channel"
        sent = user(text, blocks=True)
        write(self.path,
              {"type": "api-request-shape", "shapeHash": "s1", "shape": {"system": [], "tools": []}},
              {"type": "user", "uuid": "u1", "message": {"role": "user", "content": text}},
              self.request("r1", [cs.message_hash(sent)]))
        self.assertEqual(cs.latest_request(self.path)["messages"], {cs.message_hash(sent): sent})

    def test_a_record_with_a_lone_surrogate_does_not_switch_the_splice_off(self):
        a = user("a")
        write(self.path, {"type": "api-request-shape", "shapeHash": "s1", "shape": {"system": [], "tools": []}},
              {"type": "user", "message": {"role": "user", "content": "hi \ud83d x"}},
              {"type": "api-request-blob", "hash": cs.message_hash(a), "message": a},
              self.request("r1", [cs.message_hash(a)]))
        self.assertEqual(cs.latest_request(self.path)["hashes"], [cs.message_hash(a)])

    def test_requests_from_other_sources_are_ignored_and_a_missing_shape_gives_nothing(self):
        a = user("a")
        write(self.path, {"type": "api-request-shape", "shapeHash": "s1", "shape": {"system": [], "tools": []}},
              {"type": "api-request-blob", "hash": cs.message_hash(a), "message": a},
              self.request("r1", [cs.message_hash(a)]), self.request("r2", [], source="subagent"))
        self.assertEqual(cs.latest_request(self.path)["hashes"], [cs.message_hash(a)])
        write(self.path, self.request("r1", [cs.message_hash(a)]))
        self.assertIsNone(cs.latest_request(self.path))


class FakeAnthropic(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _Upstream)
        self.seen: list[tuple[str, dict, bytes]] = []
        self.release = threading.Event()
        self.release.set()
        threading.Thread(target=self.serve_forever, daemon=True).start()


class _Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        body_ = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.seen.append((self.path, dict(self.headers), body_))
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


class ProxyTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.upstream = FakeAnthropic()
        self.addCleanup(self.upstream.shutdown)
        self.transcript = self.dir / "main.jsonl"
        main = [user("hello"), user("skills:\n" + TAG + "list")]
        write(self.transcript, {"type": "api-request-shape", "shapeHash": "s1", "shape": {"system": [], "tools": MAIN_TOOLS}},
              *({"type": "api-request-blob", "hash": cs.message_hash(m), "message": m} for m in main),
              {"type": "api-request", "id": "r1", "sessionId": "main", "timestamp": stamp(), "querySource": "repl_main_thread",
               "shapeHash": "s1", "tail": [cs.message_hash(m) for m in main], "keep": 0})
        self.session = "main"
        self.proxy = cs.serve_in_background(lambda: self.transcript, lambda: self.session, upstream=f"http://127.0.0.1:{self.upstream.server_address[1]}")
        self.addCleanup(self.proxy.shutdown)

    def post(self, path: str, raw: bytes) -> http.client.HTTPResponse:
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_address[1], timeout=10)
        connection.request("POST", path, raw, {"content-type": "application/json", "authorization": "Bearer secret", "anthropic-beta": "b1"})
        return connection.getresponse()

    def fork_body(self, messages=None) -> bytes:
        return json.dumps(body(messages or [user("hello"), user("skills:\nlist"), user("new")])).encode()

    def test_a_messages_request_reaches_the_upstream_spliced_with_the_caller_s_headers(self):
        self.assertEqual(self.post("/v1/messages?beta=true", self.fork_body()).read(12), b"event: one\n\n")
        path, headers, sent = self.upstream.seen[0]
        sent = json.loads(sent)
        self.assertEqual(path, "/v1/messages?beta=true")
        self.assertEqual(sent["messages"][1], user("skills:\n" + TAG + "list"))
        self.assertEqual(sent["messages"][2], user("new"))
        self.assertEqual((headers["authorization"], headers["anthropic-beta"]), ("Bearer secret", "b1"))
        self.assertIn("spliced", self.proxy.notes[-1])

    def test_the_reply_streams_back_before_the_upstream_has_finished(self):
        self.upstream.release.clear()
        response = self.post("/v1/messages", self.fork_body())
        self.assertEqual(response.read(12), b"event: one\n\n")
        self.upstream.release.set()
        self.assertIn(b"event: two", response.read())

    def test_a_request_it_does_not_understand_goes_through_unchanged_with_a_note(self):
        for raw in (b"not json", b"[1]", json.dumps({"messages": [], "tools": []}).encode()):
            self.upstream.seen.clear()
            self.post("/v1/messages", raw).read()
            self.assertEqual(self.upstream.seen[0][2], raw)
            self.assertIn("skipped", self.proxy.notes[-1])

    def test_another_session_is_never_spliced(self):
        self.session = "someone-else"
        raw = self.fork_body()
        self.post("/v1/messages", raw).read()
        self.assertEqual(self.upstream.seen[0][2], raw)
        self.assertIn("another session", self.proxy.notes[-1])

    def test_only_a_path_is_forwarded_never_a_host_or_scheme(self):
        for target in ("http://evil.example/v1/messages", "evil.example:443", "*"):
            connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_address[1], timeout=10)
            connection.putrequest("POST", target, skip_accept_encoding=True)
            connection.putheader("Content-Length", "2")
            connection.endheaders(b"{}")
            self.assertEqual(connection.getresponse().status, 400, target)
        self.assertEqual(self.upstream.seen, [])

    def test_other_endpoints_are_not_touched(self):
        raw = self.fork_body()
        self.post("/v1/messages/count_tokens", raw).read()
        self.assertEqual(self.upstream.seen[0][2], raw)

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


if __name__ == "__main__":
    unittest.main()
