import http.client
import json
import os
import re
import stat
import threading
import time
import unittest

from tests.harness import HeadCase, parse_sse
from janet_voice_head.call_tools import NAMES as CALL_TOOLS, QUESTION, GOODBYE


class ConversationTest(HeadCase):
    def test_opening_a_fork_warms_it_before_anyone_speaks_and_a_guest_is_not_warmed(self):
        self.open()
        self.wait_for(lambda: self.warm_ups(), "the fork was never warmed")
        self.open("guest")
        time.sleep(0.2)
        self.assertEqual(self.prompts(), [])
        self.assertEqual(len(self.warm_ups()), 1)

    def test_a_turn_that_arrives_during_warm_up_waits_for_it_and_is_answered(self):
        self.claude_extra = ["--fake-slow-warm"]
        self.stop_head()
        self.start_head(bridge_after_s=5)
        sentences, done = self.turn(self.open(), "hello there")
        self.assertEqual(sentences, ["You said hello there.", "That is all I know."])
        self.assertEqual(len(self.warm_ups()), 1)
        self.assertNotIn("ready", self.hub.texts("voice-hard"))

    def test_a_turn_streams_each_sentence_then_done_with_latencies(self):
        sentences, done = self.turn(self.open(), "hello there")
        self.assertEqual(sentences, ["You said hello there.", "That is all I know."])
        self.assertFalse(done["end_conversation"])
        self.assertLessEqual({"first_token", "first_sentence", "total"}, set(done["latency_ms"]))
        self.assertLessEqual(done["latency_ms"]["first_token"], done["latency_ms"]["total"])

    def test_the_model_is_told_the_local_time_on_every_turn(self):
        conv = self.open()
        self.turn(conv, "one")
        self.turn(conv, "two")
        year = time.strftime("%Y")
        self.assertTrue(all("Local time: " in prompt and year in prompt for prompt in self.prompts()))

    def test_a_direct_hangup_request_still_reaches_the_model(self):
        conv = self.open()
        _, done = self.turn(conv, "Hang up.")
        self.assertFalse(done["end_conversation"])
        self.assertIn("Parker says: Hang up.", self.prompts()[0])

    def test_the_same_client_ref_gets_the_same_conversation(self):
        self.assertEqual(self.open(client_ref="wake-1"), self.open(client_ref="wake-1"))
        self.assertNotEqual(self.open(client_ref="wake-1"), self.open(client_ref="wake-2"))

    def test_requests_without_the_token_are_refused(self):
        self.assertEqual(self.request("POST", "/v1/conversations", {"channel": "desk"}, token=None)[0], 401)
        self.assertEqual(self.request("POST", "/v1/conversations", {"channel": "desk"}, token="wrong")[0], 401)

    def test_the_token_file_is_private_and_survives_a_restart(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.token_file).st_mode), 0o600)
        before = self.token
        self.stop_head()
        self.start_head()
        self.assertEqual(self.token, before)

    def test_a_turn_on_an_ended_conversation_is_refused(self):
        conv = self.open()
        self.turn(conv, "hello")
        self.end(conv)
        self.assertEqual(self.request("POST", f"/v1/conversations/{conv}/turns", {"text": "more"})[0], 409)


class InterruptTest(HeadCase):
    def test_an_interrupt_stops_the_reply_and_the_head_remembers_only_what_was_heard(self):
        conv = self.open()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        connection.request("POST", f"/v1/conversations/{conv}/turns", json.dumps({"text": "count for me"}),
                           {"Authorization": "Bearer " + self.token, "content-type": "application/json"})
        response = connection.getresponse()
        while response.fp.readline().strip():
            pass
        self.assertEqual(self.request("POST", f"/v1/conversations/{conv}/interrupt", {"heard_text": "Number 1. Number 2."})[0], 200)
        events = parse_sse(response.read().decode())
        connection.close()
        spoken = [data["text"] for name, data in events if name == "sentence"]
        self.assertLess(len(spoken), 199)
        self.assertEqual(events[-1][0], "done")

        sentences, _ = self.turn(conv, "what did I hear")
        self.assertEqual(sentences, ["You heard: Number 1.", "Number 2.."])

        self.turn(conv, "hello")
        self.end(conv)
        (merge,) = self.hub.texts("voice-hard")
        self.assertIn('only this was heard: "Number 1. Number 2."', merge)

    def test_an_interrupt_after_the_reply_finished_still_records_what_was_heard(self):
        conv = self.open()
        self.turn(conv, "hello there")
        self.request("POST", f"/v1/conversations/{conv}/interrupt", {"heard_text": "You said"})
        sentences, _ = self.turn(conv, "what did I hear")
        self.assertEqual(sentences, ["You heard: You said."])


class SoftMergeTest(HeadCase):
    def test_an_ask_reaches_main_during_the_call_and_its_relay_is_never_spoken(self):
        conv = self.open()
        sentences, _ = self.turn(conv, "please order filament")
        self.assertEqual(sentences, ["I will pass that to main."])
        self.wait_for(lambda: self.hub.texts("voice-soft"), "the ask never reached the hub")
        (soft,) = self.hub.texts("voice-soft")
        self.assertIn(f"conv={conv} exchange=1", soft)
        self.assertIn("- please order filament", soft)
        self.assertEqual(self.hub.texts("voice-hard"), [])

    def test_small_talk_waits_for_the_hard_merge(self):
        conv = self.open()
        self.turn(conv, "hello there")
        time.sleep(0.3)
        self.assertEqual(self.hub.accepted, [])

    def test_a_soft_merge_refused_by_a_down_hub_is_sent_once_when_the_hub_returns(self):
        self.hub.down = True
        conv = self.open()
        self.turn(conv, "please order filament")
        time.sleep(0.5)
        self.hub.down = False
        self.wait_for(lambda: self.hub.texts("voice-soft"), "the soft merge was never retried")
        time.sleep(2.5)
        self.assertEqual(len(self.hub.texts("voice-soft")), 1)


class RelayTest(HeadCase):
    def test_a_reply_that_opens_with_an_upper_case_relay_speaks_what_follows_and_relays_the_ask(self):
        conv = self.open()
        sentences, _ = self.turn(conv, "relayfirst please")
        self.assertEqual(sentences, ["Sure thing."])
        self.wait_for(lambda: self.hub.texts("voice-soft"), "the ask never reached the hub")
        self.assertIn("- do the first thing", self.hub.texts("voice-soft")[0])

    def test_every_relay_block_of_a_reply_reaches_main_and_none_is_spoken(self):
        conv = self.open()
        sentences, _ = self.turn(conv, "tworelays please")
        self.assertEqual(sentences, ["Okay.", "Also noted.", "Done."])
        self.wait_for(lambda: self.hub.texts("voice-soft"), "the asks never reached the hub")
        (soft,) = self.hub.texts("voice-soft")
        self.assertIn("- first thing", soft)
        self.assertIn("- second thing", soft)

    def test_a_reply_that_is_only_a_relay_still_gets_a_spoken_acknowledgement(self):
        sentences, _ = self.turn(self.open(), "onlyrelay please")
        self.assertEqual(sentences, ["Okay, I will pass that to main Janet."])


class EverySoftMergeTest(HeadCase):
    overrides = {"soft_merge": "every"}

    def test_every_exchange_is_relayed_when_configured(self):
        conv = self.open()
        self.turn(conv, "hello there")
        self.wait_for(lambda: self.hub.texts("voice-soft"), "the exchange never reached the hub")


class HardMergeTest(HeadCase):
    def talk(self) -> str:
        conv = self.open()
        self.turn(conv, "hello there")
        self.turn(conv, "please order filament")
        self.wait_for(lambda: self.hub.texts("voice-soft"), "the ask never reached the hub")
        return conv

    def test_ending_delivers_the_whole_conversation_once(self):
        conv = self.talk()
        status, reply = self.end(conv)
        self.assertEqual((status, reply["merged"]), (200, True))
        (merge,) = self.hub.texts("voice-hard")
        self.assertIn(f"conv={conv}", merge)
        self.assertIn("1. Parker: hello there", merge)
        self.assertIn("Janet: You said hello there. That is all I know.", merge)
        self.assertIn("Summary: They talked about test things.", merge)
        self.assertIn("[already relayed, exchange 2] please order filament", merge)
        self.assertIn("parent session parent-session-id, head session fake-session-", merge)

    def test_ending_twice_delivers_once(self):
        conv = self.talk()
        self.end(conv)
        status, reply = self.end(conv)
        self.assertEqual((status, reply["merged"]), (200, True))
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)

    def test_a_conversation_with_no_exchange_delivers_nothing(self):
        conv = self.open()
        self.assertEqual(self.end(conv)[1]["merged"], True)
        self.assertEqual(self.hub.accepted, [])

    def test_a_restart_ends_open_conversations_and_merges_them_once(self):
        conv = self.talk()
        self.stop_head()
        self.start_head()
        self.wait_for(lambda: self.hub.texts("voice-hard"), "the conversation was never merged")
        self.assertEqual(self.end(conv)[1]["merged"], True)
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)
        self.assertIn("ended by head_restart", self.hub.texts("voice-hard")[0])

    def test_a_merge_refused_by_a_down_hub_lands_once_when_the_hub_returns(self):
        conv = self.talk()
        self.hub.down = True
        self.assertEqual(self.end(conv)[0], 503)
        self.hub.down = False
        self.wait_for(lambda: self.hub.texts("voice-hard"), "the merge was never retried")
        self.assertEqual(self.end(conv)[1]["merged"], True)
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)


class OversizeAndRefusalTest(HeadCase):
    def test_a_conversation_too_big_for_the_hub_still_lands_and_names_its_archive(self):
        conv = self.open()
        self.turn(conv, "please order " + "x" * 25000)
        self.turn(conv, "hello there")
        status, reply = self.end(conv)
        self.assertEqual((status, reply["merged"]), (200, True))
        (merge,) = self.hub.texts("voice-hard")
        self.assertLessEqual(len(merge), 20000)
        self.assertIn(f"{conv}.jsonl", merge.split("Cut to fit", 1)[1])
        self.assertIn(f'"heard": "please order {"x" * 25000}', (self.root / "state" / "conversations" / f"{conv}.jsonl").read_text())

    def test_a_guest_who_speaks_at_length_still_lands(self):
        conv = self.open("guest")
        self.turn(conv, "hello " * 5000)
        self.assertEqual(self.end(conv)[1]["merged"], True)
        self.assertLessEqual(len(self.hub.texts("voice-hard")[0]), 20000)

    def test_a_hub_that_refuses_for_good_is_asked_twice_and_then_left_alone(self):
        conv = self.open()
        self.turn(conv, "hello there")
        self.hub.refuse_with = 400
        status, reply = self.end(conv)
        self.assertEqual((status, reply["merged"]), (200, False))
        self.assertTrue(reply["delivery"].startswith("undeliverable"))
        self.assertIn(f"{conv}.jsonl", reply["delivery"])
        attempts = self.hub.attempts
        time.sleep(4.5)
        self.assertEqual((attempts, self.hub.attempts), (2, 2))

    def test_a_hub_that_refuses_only_the_full_text_gets_a_notice_that_names_the_archive(self):
        self.hub.refuse_when = lambda text: "<<<SPEECH" in text
        conv = self.open()
        self.turn(conv, "hello there")
        self.assertEqual(self.end(conv)[1]["merged"], True)
        (notice,) = self.hub.texts("voice-hard")
        self.assertIn(f"{conv}.jsonl", notice)
        self.assertIn("refused the full record", notice)

    def test_a_hub_server_error_is_retried_until_it_lands(self):
        conv = self.open()
        self.turn(conv, "hello there")
        self.hub.refuse_with = 500
        self.assertEqual(self.end(conv)[0], 503)
        self.hub.refuse_with = None
        self.wait_for(lambda: self.hub.texts("voice-hard"), "the merge was never retried")
        self.assertEqual(self.end(conv)[1]["merged"], True)

    def test_a_soft_merge_refused_for_good_is_not_retried_and_the_hard_merge_carries_the_ask_as_new(self):
        self.hub.refuse_with = 400
        conv = self.open()
        self.turn(conv, "please order filament")
        self.wait_for(lambda: self.hub.attempts >= 1, "the soft merge was never tried")
        time.sleep(4.5)
        self.assertEqual(self.hub.attempts, 1)
        self.hub.refuse_with = None
        self.end(conv)
        (merge,) = self.hub.texts("voice-hard")
        self.assertIn("[new] please order filament", merge)


class UnmergedChannelTest(HeadCase):
    overrides = {"unmerged_channels": ["desk-test"]}

    def test_a_test_channel_is_answered_and_ended_but_never_reaches_main(self):
        conv = self.open(channel="desk-test")
        sentences, _ = self.turn(conv, "please order filament")
        self.assertEqual(sentences, ["I will pass that to main."])
        self.assertEqual(self.end(conv)[1]["merged"], True)
        time.sleep(0.3)
        self.assertEqual(self.hub.accepted, [])


class BridgeTest(HeadCase):
    def cold_head(self, **overrides):
        self.claude_extra = ["--fake-slow-warm"]
        self.stop_head()
        self.start_head(**{"bridge_after_s": 0.3, **overrides})

    def events(self, conv, text):
        status, events = self.request("POST", f"/v1/conversations/{conv}/turns", {"text": text})
        self.assertEqual(status, 200, events)
        return events

    def test_a_cold_first_turn_says_one_short_line_before_the_real_reply_and_it_is_not_remembered(self):
        self.cold_head()
        conv = self.open()
        events = self.events(conv, "hello there")
        sentences = [data for name, data in events if name == "sentence"]
        self.assertTrue(sentences[0].get("bridge"))
        self.assertEqual([s["text"] for s in sentences[1:]], ["You said hello there.", "That is all I know."])
        self.assertEqual(sum(1 for s in sentences if s.get("bridge")), 1)
        self.assertIn("bridge", events[-1][1]["latency_ms"])
        self.end(conv)
        self.assertNotIn(sentences[0]["text"], self.hub.texts("voice-hard")[0])

    def test_a_turn_that_starts_warm_gets_no_bridge(self):
        self.cold_head()
        conv = self.open()
        self.turn(conv, "one")
        sentences = [data for name, data in self.events(conv, "two") if name == "sentence"]
        self.assertFalse(any(s.get("bridge") for s in sentences))

    def test_a_reply_that_is_ready_in_time_gets_no_bridge(self):
        self.stop_head()
        self.start_head(bridge_after_s=5)
        sentences = [data for name, data in self.events(self.open(), "hello there") if name == "sentence"]
        self.assertFalse(any(s.get("bridge") for s in sentences))

    def test_a_second_turn_while_the_first_waits_is_refused_and_gets_no_bridge_of_its_own(self):
        self.cold_head()
        conv = self.open()
        results = []
        first = threading.Thread(target=lambda: results.append(self.events(conv, "one")))
        first.start()
        time.sleep(0.1)
        status, _ = self.request("POST", f"/v1/conversations/{conv}/turns", {"text": "two"})
        first.join(10)
        self.assertEqual(status, 409)
        self.assertEqual(sum(1 for n, d in results[0] if n == "sentence" and d.get("bridge")), 1)

    def test_cutting_in_during_the_bridge_stops_the_real_reply_from_being_asked_for(self):
        self.cold_head()
        conv = self.open()
        results = []
        turn = threading.Thread(target=lambda: results.append(self.events(conv, "hello there")))
        turn.start()
        time.sleep(0.45)
        self.request("POST", f"/v1/conversations/{conv}/interrupt", {"heard_text": "Let me"})
        turn.join(10)
        sentences = [d["text"] for n, d in results[0] if n == "sentence"]
        self.assertEqual(len(sentences), 1)
        self.assertEqual(self.prompts(), [])

    def test_a_cold_fork_gets_a_bridge_even_with_the_warm_up_turned_off(self):
        self.claude_extra = ["--fake-slow-first"]
        self.stop_head()
        self.start_head(bridge_after_s=0.3, warm_up=False)
        sentences = [d for n, d in self.events(self.open(), "hello there") if n == "sentence"]
        self.assertTrue(sentences[0].get("bridge"))

    def test_the_bridge_can_be_turned_off(self):
        self.cold_head(bridge_after_s=0)
        sentences = [data for name, data in self.events(self.open(), "hello there") if name == "sentence"]
        self.assertFalse(any(s.get("bridge") for s in sentences))


class IdleTest(HeadCase):
    overrides = {"idle_timeout_s": 0.5}

    def test_an_abandoned_conversation_merges_itself_without_a_model_call(self):
        conv = self.open()
        self.turn(conv, "hello there")
        self.turn(conv, "hello again")
        asked = len(self.prompts())
        self.wait_for(lambda: self.hub.texts("voice-hard"), "the idle conversation was never merged")
        self.assertIn("ended by idle_timeout", self.hub.texts("voice-hard")[0])
        self.assertEqual(len(self.prompts()), asked)
        self.assertEqual(self.request("POST", f"/v1/conversations/{conv}/turns", {"text": "more"})[0], 409)


class CrashTest(HeadCase):
    def crash_during_merge(self) -> str:
        conv = self.open()
        self.turn(conv, "hello there")
        self.hub.on_accept = self.kill_head
        try:
            self.end(conv)
        except (OSError, http.client.HTTPException):
            pass
        self.hub.on_accept = None
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)
        return conv

    def settle(self, conv: str) -> None:
        self.start_head()
        self.wait_for(lambda: self.end(conv)[0] == 200, "the merge never settled after the restart")
        time.sleep(2.5)

    def test_a_merge_still_queued_in_the_hub_is_not_sent_again(self):
        conv = self.crash_during_merge()
        self.settle(conv)
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)

    def test_a_merge_main_already_read_is_not_sent_again(self):
        conv = self.crash_during_merge()
        self.hub.main_consumes()
        self.settle(conv)
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)

    def test_a_marker_main_merely_quoted_does_not_count_as_delivered(self):
        conv = self.open()
        self.turn(conv, "hello there")
        self.hub.down = True
        self.end(conv)
        self.kill_head()
        with open(self.hub.transcript, "a") as file:
            file.write(json.dumps({"type": "user", "message": {"content": f"tool output quoting key=voice-hard:{conv}]"}}) + "\n")
        self.hub.down = False
        self.settle(conv)
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)

    def test_an_ask_the_hub_accepted_before_the_crash_is_not_handed_to_main_as_new(self):
        conv = self.open()
        self.hub.on_accept = self.kill_head
        try:
            self.turn(conv, "please order filament")
        except (OSError, http.client.HTTPException, StopIteration):
            pass
        self.wait_for(lambda: self.head.poll() is not None, "the head survived")
        self.hub.on_accept = None
        self.settle(conv)
        self.assertEqual(len(self.hub.texts("voice-soft")), 1)
        (merge,) = self.hub.texts("voice-hard")
        self.assertIn("[already relayed, exchange 1] please order filament", merge)

    def test_a_hub_that_drops_repeats_is_sent_the_same_key_again(self):
        conv = self.crash_during_merge()
        self.hub.drops_repeats = True
        self.hub.main_consumes()
        self.hub.transcript.write_text("")
        self.settle(conv)
        self.assertEqual(len(self.hub.texts("voice-hard")), 1)
        self.assertEqual(self.hub.accepted[0]["key"], f"voice-hard:{conv}")


class TierTest(HeadCase):
    def test_a_personal_conversation_forks_the_parent_session_without_tools_or_hub_access(self):
        self.turn(self.open("personal"), "hello")
        (launch,) = self.launches()
        argv = launch["argv"]
        self.assertEqual(argv[argv.index("--resume") + 1], "parent-session-id")
        self.assertIn("--fork-session", argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", argv)
        self.assertFalse([name for name in launch["env"] if name.startswith(("HERMES", "CC_LINK", "CLAUDE", "ANTHROPIC"))])

    def test_a_fork_resumes_a_copy_of_mains_transcript_from_its_last_compaction(self):
        def line(**fields):
            return json.dumps(fields, separators=(",", ":")) + "\n"
        main = (line(uuid="old", parentUuid=None, type="user") + line(uuid="b", parentUuid=None, type="system", subtype="compact_boundary")
                + line(uuid="live", parentUuid="b", type="user"))
        self.hub.transcript.write_text(main)
        self.turn(self.open("personal"), "hello")
        (launch,) = self.launches()
        argv = launch["argv"]
        resumed = argv[argv.index("--resume") + 1]
        self.assertNotEqual(resumed, "parent-session-id")
        copy = self.hub.transcript.parent.parent / (re.sub(r"[^A-Za-z0-9]", "-", str(self.root / "state" / "fork"))) / f"{resumed}.jsonl"
        self.assertEqual([json.loads(row)["uuid"] for row in copy.read_text().splitlines()], ["b", "live"])
        self.assertEqual(self.hub.transcript.read_text(), main)

    def test_a_main_like_fork_carries_mains_flags_and_env_but_no_way_to_run_a_tool(self):
        self.stop_head()
        self.start_head(main_like_fork=True, main_like_args=["--plugin-dir", "/main/plugin"], main_like_env={"MAIN_LIKE_MARK": "1"})
        sentences, _ = self.turn(self.open("personal"), "hello")
        self.assertEqual(sentences, ["You said hello.", "That is all I know."])
        launch = self.launches()[-1]
        argv = launch["argv"]
        self.assertNotIn("--tools", argv)
        self.assertNotIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        self.assertEqual(argv[argv.index("--plugin-dir") + 1], "/main/plugin")
        self.assertIn("--fork-session", argv)
        self.assertEqual(launch["cwd"], str(self.root))
        self.assertEqual(launch["extra"], "1")
        self.assertRegex(launch["base_url"], r"^http://127\.0\.0\.1:\d+$")

    def test_the_cache_proxy_can_be_turned_off_for_a_main_like_fork(self):
        self.stop_head()
        self.start_head(main_like_fork=True, cache_splice=False)
        self.turn(self.open("personal"), "hello")
        self.assertIsNone(self.launches()[-1]["base_url"])

    def test_a_guest_is_never_launched_main_like(self):
        self.stop_head()
        self.start_head(main_like_fork=True)
        self.turn(self.open("guest"), "hello")
        argv = self.launches()[-1]["argv"]
        self.assertIn("--tools", argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")

    def test_trimming_can_be_turned_off(self):
        self.stop_head()
        self.start_head(trim_transcript=False)
        self.hub.transcript.write_text(json.dumps({"uuid": "b", "parentUuid": None, "type": "system", "subtype": "compact_boundary"}, separators=(",", ":")) + "\n")
        self.turn(self.open("personal"), "hello")
        argv = self.launches()[-1]["argv"]
        self.assertEqual(argv[argv.index("--resume") + 1], "parent-session-id")

    def test_a_fork_runs_outside_mains_directory_so_its_transcript_never_joins_mains(self):
        self.turn(self.open("personal"), "hello")
        (launch,) = self.launches()
        self.assertNotEqual(launch["cwd"], str(self.root))
        link = self.root / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", launch["cwd"]) / "parent-session-id.jsonl"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), self.hub.transcript.resolve())

    def test_a_guest_conversation_is_a_fresh_session_outside_the_parent(self):
        self.turn(self.open("guest"), "hello")
        (launch,) = self.launches()
        self.assertNotIn("--resume", launch["argv"])
        self.assertNotEqual(launch["cwd"], str(self.root))
        self.assertEqual(os.listdir(launch["cwd"]), [])

    def test_a_missing_tier_gets_the_least_privileged_head(self):
        self.turn(self.open(None), "hello")
        self.assertNotIn("--resume", self.launches()[0]["argv"])

    def test_an_unknown_tier_is_refused(self):
        self.assertEqual(self.request("POST", "/v1/conversations", {"channel": "desk", "tier": "admin"})[0], 400)

    def test_a_guest_head_never_speaks_the_account_address(self):
        sentences, _ = self.turn(self.open("guest"), "what is the email")
        self.assertEqual(sentences, ["The account is a private address, I think."])

    def test_a_guest_ask_is_not_relayed_and_merges_as_untrusted_speech(self):
        conv = self.open("room")
        self.turn(conv, "please order filament")
        self.end(conv)
        self.assertEqual(self.hub.texts("voice-soft"), [])
        (merge,) = self.hub.texts("voice-hard")
        self.assertIn("untrusted quoted speech", merge)
        self.assertIn("1. Speaker: please order filament", merge)


class WebToolsTest(HeadCase):
    overrides = {"web_tools": ["WebSearch", "WebFetch"]}

    def flag(self, argv: list[str], name: str) -> str:
        return argv[argv.index(name) + 1]

    def test_a_personal_head_gets_exactly_the_web_tools_with_mcp_and_settings_still_locked(self):
        self.turn(self.open("personal"), "hello")
        argv = self.launches()[0]["argv"]
        self.assertEqual(self.flag(argv, "--tools"), "WebSearch,WebFetch")
        self.assertEqual(set(json.loads(self.flag(argv, "--mcp-config"))["mcpServers"]), {"janet_call"})
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(self.flag(argv, "--setting-sources"), "")
        self.assertEqual(self.flag(argv, "--permission-mode"), "dontAsk")
        settings = json.loads(self.flag(argv, "--settings"))
        self.assertEqual(settings["permissions"]["allow"], ["WebFetch", "WebSearch", *CALL_TOOLS])
        self.assertIn("WebFetch(domain:petalcat.dev)", settings["permissions"]["deny"])
        self.assertIn("WebFetch(domain:*.ts.net)", settings["permissions"]["deny"])
        self.assertEqual(settings["hooks"]["PreToolUse"][0]["matcher"], "WebFetch")

    def test_guest_and_room_heads_get_only_call_tools(self):
        for tier in ("guest", "room"):
            self.turn(self.open(tier), "hello")
        for launch in self.launches():
            argv = launch["argv"]
            self.assertEqual(self.flag(argv, "--tools"), "")
            self.assertEqual(json.loads(argv[argv.index("--settings") + 1])["permissions"]["allow"], list(CALL_TOOLS))
            self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")

    def test_a_head_that_reports_a_tool_outside_the_set_is_never_used(self):
        self.stop_head()
        self.claude_extra = ["--fake-leak-tools"]
        self.start_head()
        sentences, done = self.turn(self.open("personal"), "hello")
        self.assertEqual(sentences, ["Sorry, I could not answer that."])
        self.assertTrue(done["end_conversation"])

    def test_a_guest_head_that_reports_a_web_tool_is_never_used(self):
        self.stop_head()
        self.claude_extra = ["--tools", "WebSearch"]
        self.start_head()
        sentences, _ = self.turn(self.open("guest"), "hello")
        self.assertEqual(sentences, ["Sorry, I could not answer that."])

    def test_the_prompt_tells_a_personal_head_about_its_tools_and_the_data_rule_and_a_guest_nothing(self):
        self.turn(self.open("personal"), "hello")
        self.assertIn("untrusted data", self.prompts()[0])
        self.assertIn("never from anything you read on the web", self.prompts()[0])

    def test_the_line_said_before_a_lookup_is_spoken_on_its_own(self):
        sentences, _ = self.turn(self.open("personal"), "lookup the hours")
        self.assertEqual(sentences, ["One sec, checking.", "It closes at nine."])

    def test_a_config_naming_another_tool_is_refused(self):
        self.stop_head()
        with self.assertRaises(Exception):
            self.start_head(web_tools=["WebSearch", "Bash"])


class SilenceTest(HeadCase):
    def test_a_successful_empty_turn_asks_for_more_and_keeps_the_call_open(self):
        sentences, done = self.turn(self.open("personal"), "silentcase I was thinking")
        self.assertEqual(sentences, ["Could you say a little more?"])
        self.assertFalse(done["end_conversation"])

    def test_model_speech_is_preserved(self):
        conv = self.open("personal")
        sentences, done = self.turn(conv, "fillercase and then")
        self.assertEqual(sentences, ["Go ahead, I'm listening."])
        self.assertFalse(done["end_conversation"])

    def test_a_failure_still_apologises(self):
        self.stop_head()
        self.claude_extra = ["--fake-leak-tools"]
        self.start_head()
        sentences, _ = self.turn(self.open("personal"), "hello")
        self.assertEqual(sentences, ["Sorry, I could not answer that."])


class MainLikeWebToolsTest(HeadCase):
    def settings_of(self, argv):
        self.assertEqual(argv.count("--settings"), 1, "claude reads only the last --settings")
        return json.loads(argv[argv.index("--settings") + 1])

    def test_a_main_like_fork_merges_the_web_tools_into_its_own_settings_file(self):
        base = self.root / "fork-settings.json"
        base.write_text(json.dumps({"deniedMcpServers": [{"serverName": "x"}], "permissions": {"deny": ["Bash", "WebFetch", "WebSearch", "Edit"]}}))
        self.stop_head()
        self.start_head(main_like_fork=True, web_tools=["WebSearch", "WebFetch"], main_like_args=["--settings", str(base), "--plugin-dir", "/main/plugin"])
        self.turn(self.open("personal"), "hello")
        argv = self.launches()[-1]["argv"]
        settings = self.settings_of(argv)
        self.assertEqual(settings["deniedMcpServers"], [{"serverName": "x"}])
        self.assertEqual(settings["permissions"]["allow"], ["WebFetch", "WebSearch", *CALL_TOOLS])
        deny = settings["permissions"]["deny"]
        self.assertTrue({"Bash", "Edit", "WebFetch(domain:petalcat.dev)"} <= set(deny))
        self.assertTrue({"WebFetch", "WebSearch"}.isdisjoint(deny))
        self.assertEqual(settings["hooks"]["PreToolUse"][0]["matcher"], "WebFetch")
        self.assertTrue(settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"].endswith(" || exit 2"))
        self.assertEqual(argv[argv.index("--plugin-dir") + 1], "/main/plugin")
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertIn("untrusted data", self.prompts()[0])

    def test_a_main_like_fork_without_a_settings_file_gets_ours(self):
        self.stop_head()
        self.start_head(main_like_fork=True, web_tools=["WebSearch"])
        self.turn(self.open("personal"), "hello")
        self.assertEqual(self.settings_of(self.launches()[-1]["argv"])["permissions"]["allow"], ["WebSearch", *CALL_TOOLS])

    def test_a_main_like_fork_without_web_tools_keeps_its_args_as_they_are(self):
        self.stop_head()
        self.start_head(main_like_fork=True, main_like_args=["--plugin-dir", "/p"])
        self.turn(self.open("personal"), "hello")
        self.assertEqual(self.settings_of(self.launches()[-1]["argv"])["permissions"]["allow"], list(CALL_TOOLS))

    def test_a_guest_is_still_tool_less_beside_a_main_like_web_fork(self):
        self.stop_head()
        self.start_head(main_like_fork=True, web_tools=["WebSearch", "WebFetch"])
        self.turn(self.open("guest"), "hello")
        argv = self.launches()[-1]["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(json.loads(argv[argv.index("--settings") + 1])["permissions"]["allow"], list(CALL_TOOLS))


class WebToolsOffTest(HeadCase):
    def test_by_default_a_personal_head_has_only_call_tools(self):
        self.turn(self.open("personal"), "hello")
        argv = self.launches()[0]["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(json.loads(argv[argv.index("--settings") + 1])["permissions"]["allow"], list(CALL_TOOLS))
        self.assertIn("Your only tools control this call", self.prompts()[0])


class LateToolListTest(HeadCase):
    """A fork that names its tools only on its first turn, as forks do since 2026-11-17."""

    overrides = {"ready_timeout_s": 3}

    def setUp(self):
        super().setUp()
        self.stop_head()
        self.claude_extra = ["--fake-late-init"]
        self.start_head()

    def test_the_first_turn_is_answered_without_waiting_for_the_tool_list(self):
        conv = self.open("personal")
        started = time.monotonic()
        sentences, done = self.turn(conv, "hello there")
        self.assertEqual(sentences, ["You said hello there.", "That is all I know."])
        self.assertFalse(done["end_conversation"])
        self.assertIsNotNone(done["latency_ms"]["first_token"])
        self.assertLess(time.monotonic() - started, 2.5, "the turn waited out the ready timeout")

    def test_the_fork_and_where_it_forked_from_are_still_recorded(self):
        conv = self.open("personal")
        self.turn(conv, "hello")
        records = [json.loads(line) for line in (self.root / "state" / "conversations" / f"{conv}.jsonl").read_text().splitlines()]
        session = [record for record in records if record["kind"] == "session"]
        self.assertEqual(len(session), 1)
        self.assertTrue(session[0]["session_id"].startswith("fake-session-"))
        self.assertIsNotNone(session[0]["fork_point"])

    def test_a_fork_whose_late_list_has_tools_says_nothing_it_generated(self):
        self.stop_head()
        self.claude_extra = ["--fake-late-init", "--fake-leak-tools"]
        self.start_head()
        sentences, done = self.turn(self.open("personal"), "hello")
        self.assertEqual(sentences, ["Sorry, I could not answer that."])
        self.assertTrue(done["end_conversation"])


class UnsafeSessionTest(HeadCase):
    def test_a_session_that_comes_up_with_tools_is_never_used(self):
        self.stop_head()
        self.claude_extra = ["--fake-leak-tools"]
        self.start_head()
        sentences, done = self.turn(self.open("personal"), "hello")
        self.assertEqual(sentences, ["Sorry, I could not answer that."])
        self.assertTrue(done["end_conversation"])
        self.assertEqual(self.prompts(), [])


if __name__ == "__main__":
    unittest.main()


class AgenticHangupTest(HeadCase):
    def tool(self, conv, *names):
        return self.turn(conv, "fake-call-tools:" + ",".join(names))

    def test_model_tool_calls_ask_then_end_with_goodbye_and_merge(self):
        conv = self.open(channel="phone-app")
        sentences, done = self.tool(conv, "ask_to_end_call")
        self.assertEqual(sentences, [QUESTION])
        self.assertFalse(done["end_conversation"])
        sentences, done = self.tool(conv, "end_call")
        self.assertEqual(sentences, [GOODBYE])
        self.assertTrue(done["end_conversation"])
        self.end(conv)
        self.assertIn(QUESTION, self.hub.texts("voice-hard")[0])
        self.assertIn(GOODBYE, self.hub.texts("voice-hard")[0])

    def test_end_without_question_or_in_the_question_turn_is_refused(self):
        conv = self.open()
        self.assertFalse(self.tool(conv, "end_call")[1]["end_conversation"])
        sentences, done = self.tool(conv, "ask_to_end_call", "end_call")
        self.assertEqual(sentences, [QUESTION])
        self.assertFalse(done["end_conversation"])

    def test_a_continued_or_ambiguous_turn_expires_confirmation(self):
        conv = self.open()
        for continued in ("Actually, tell me about tomorrow", "I am not sure", "No, but one more thing"):
            self.tool(conv, "ask_to_end_call")
            self.assertFalse(self.turn(conv, continued)[1]["end_conversation"])
            self.assertFalse(self.tool(conv, "end_call")[1]["end_conversation"])

    def test_interruption_during_question_playback_invalidates_consent(self):
        conv = self.open()
        self.tool(conv, "ask_to_end_call")
        self.request("POST", f"/v1/conversations/{conv}/interrupt", {"heard_text": "Is there"})
        self.assertFalse(self.tool(conv, "end_call")[1]["end_conversation"])
        self.tool(conv, "ask_to_end_call")
        self.assertTrue(self.tool(conv, "end_call")[1]["end_conversation"])

    def test_another_conversation_cannot_use_the_question(self):
        first, second = self.open(), self.open("guest")
        self.tool(first, "ask_to_end_call")
        self.assertFalse(self.tool(second, "end_call")[1]["end_conversation"])
        self.assertTrue(self.tool(first, "end_call")[1]["end_conversation"])

    def test_guest_room_web_and_main_like_sessions_have_the_same_protocol(self):
        for options, tier in (({}, "guest"), ({}, "room"), ({"web_tools": ["WebSearch"]}, "personal"),
                              ({"main_like_fork": True}, "personal")):
            with self.subTest(tier=tier, options=options):
                self.stop_head()
                self.start_head(**options)
                conv = self.open(tier)
                self.assertFalse(self.tool(conv, "ask_to_end_call")[1]["end_conversation"])
                sentences, done = self.tool(conv, "end_call")
                self.assertEqual(sentences, [GOODBYE])
                self.assertTrue(done["end_conversation"])
                self.end(conv)


class ClosingSpeechTest(HeadCase):
    def setUp(self):
        super().setUp()
        self.stop_head()
        self.claude_extra = ["--fake-call-speech"]
        self.start_head()

    def tool(self, conv, name):
        return self.turn(conv, "fake-call-tools:" + name)

    def test_call_control_continuation_is_not_spoken_twice(self):
        sentences, done = self.tool(self.open(), "ask_to_end_call")
        self.assertEqual(sentences, ["All set.", QUESTION])
        self.assertFalse(done["end_conversation"])

    def test_confirmed_close_speaks_only_one_goodbye(self):
        conv = self.open()
        self.tool(conv, "ask_to_end_call")
        sentences, done = self.tool(conv, "end_call")
        self.assertEqual(sentences, [GOODBYE])
        self.assertTrue(done["end_conversation"])

    def test_refused_call_control_keeps_the_models_explanation(self):
        sentences, done = self.tool(self.open(), "end_call")
        self.assertEqual(sentences, ["All set.", "All set."])
        self.assertFalse(done["end_conversation"])

    def test_continued_topic_keeps_its_reply_after_a_closing_question(self):
        conv = self.open()
        self.tool(conv, "ask_to_end_call")
        sentences, done = self.turn(conv, "one more topic")
        self.assertEqual(sentences, ["You said one more topic.", "That is all I know."])
        self.assertFalse(done["end_conversation"])


    def test_closing_question_preserves_relay_after_the_tool(self):
        self.stop_head()
        self.claude_extra += ["--fake-call-relay"]
        self.start_head()
        sentences, done = self.tool(self.open(), "ask_to_end_call")
        self.assertEqual(sentences, ["All set.", QUESTION])
        self.assertFalse(done["end_conversation"])
        self.wait_for(lambda: self.hub.texts("voice-soft"), "closing turn lost its relay")
        self.assertIn("schedule the reminder", self.hub.texts("voice-soft")[0])
