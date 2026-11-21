import http.client
import json

from tests.harness import HeadCase, parse_sse


class TimingTest(HeadCase):
    overrides = {"warm_up": False, "bridge_after_s": 0}

    def records(self):
        return [json.loads(line[line.index('{"event":'):])
                for line in (self.root / "head.err").read_text().splitlines() if '{"event":' in line]

    def test_delayed_model_events_are_correlated_and_persisted_without_content(self):
        self.stop_head()
        self.claude_extra = ["--fake-timing"]
        self.start_head()
        conv = self.open(tier="guest")
        sentences, done = self.turn(conv, "private spoken canary")
        self.assertEqual(sentences, ["Hello there."])
        self.assertEqual((done["conversation_id"], done["turn"]), (conv, 1))
        records = self.records()
        by_event = {record["event"]: record for record in records}
        request = by_event["model_request"]["elapsed_ms"]
        token = by_event["model_first_token"]["elapsed_ms"]
        sentence = by_event["head_first_sentence"]["elapsed_ms"]
        self.assertGreaterEqual(token - request, 100)
        self.assertGreaterEqual(sentence - token, 100)
        self.assertLess(sentence - request, 2000)
        self.assertTrue(all(r["conversation_id"] == conv and r["turn"] == 1 and r["at"] > 0 for r in records))
        self.assertNotIn("private spoken canary", json.dumps(records))
        usage = by_event["model_usage"]["usage"]
        self.assertEqual(usage, {"input_tokens": 10, "cache_read_input_tokens": 300,
                                 "cache_creation_input_tokens": 20, "output_tokens": 6})
        self.wait_for(lambda: any(r["event"] == "head_turn_finished" for r in self.records()), "timing was not logged")
        timing = next(record for record in self.records() if record["event"] == "head_turn_finished")
        self.assertEqual(timing["usage"], usage)
        self.assertGreaterEqual(timing["latency_ms"]["first_token"], 100)
        self.assertNotIn("private spoken canary", json.dumps(timing))

    def test_call_tool_logs_acceptance_and_time_without_arguments(self):
        conv = self.open(tier="guest")
        self.turn(conv, "fake-call-tools:ask_to_end_call")
        self.turn(conv, "fake-call-tools:end_call")
        rows = [r for r in self.records() if r["event"] == "call_tool"]
        self.assertEqual([(r["tool"], r["turn"], r["accepted"]) for r in rows],
                         [("ask_to_end_call", 1, True), ("end_call", 2, True)])
        self.assertTrue(all(r["elapsed_ms"] >= 0 and r["duration_ms"] >= 0 for r in rows))

    def test_missing_usage_stays_unknown_and_turn_correlation_advances(self):
        conv = self.open(tier="guest")
        for number in (1, 2):
            _, done = self.turn(conv, "ordinary reply")
            self.assertEqual(done["turn"], number)
        self.wait_for(lambda: len([r for r in self.records() if r["event"] == "head_turn_finished"]) == 2,
                      "turn timing summaries were not logged")
        summaries = [r for r in self.records() if r["event"] == "head_turn_finished"]
        self.assertEqual([r["turn"] for r in summaries], [1, 2])
        self.assertTrue(all(r["usage"] == {} for r in summaries))
        self.assertEqual(len([r for r in self.records() if r["event"] == "model_first_token"]), 2)

    def test_duplicate_response_usage_is_not_inflated_when_process_dies(self):
        self.stop_head()
        self.claude_extra = ["--fake-timing-failure"]
        self.start_head()
        conv = self.open(tier="guest")
        self.turn(conv, "private failure canary")
        self.wait_for(lambda: any(r["event"] == "head_turn_finished" for r in self.records()), "missing failure timing")
        summary = next(r for r in self.records() if r["event"] == "head_turn_finished")
        self.assertEqual(summary["usage"], {"input_tokens": 7, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20})
        self.assertEqual(len([r for r in self.records() if r["event"] == "model_usage"]), 1)
        self.assertNotIn("private failure canary", json.dumps(self.records()))

    def test_interrupt_during_warmup_has_a_distinct_request_turn(self):
        self.stop_head()
        self.claude_extra = ["--fake-slow-warm"]
        self.start_head(warm_up=True, bridge_after_s=0.05)
        conv = self.open()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(connection.close)
        connection.request("POST", f"/v1/conversations/{conv}/turns", json.dumps({"text": "first"}),
                           {"Authorization": "Bearer " + self.token})
        response = connection.getresponse()
        first = response.readline() + response.readline() + response.readline()
        bridge = parse_sse(first.decode())[0][1]
        self.assertTrue(bridge["bridge"])
        self.assertEqual((bridge["conversation_id"], bridge["turn"]), (conv, 1))
        self.request("POST", f"/v1/conversations/{conv}/interrupt", {"heard_text": "new turn"})
        events = parse_sse(response.read().decode())
        self.assertEqual(next(data["turn"] for name, data in events if name == "done"), 1)
        _, done = self.turn(conv, "second")
        self.assertEqual(done["turn"], 2)
