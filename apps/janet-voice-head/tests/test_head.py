import http.client
import json
import os
import re
import stat
import time
import unittest

from tests.harness import HeadCase, parse_sse


class ConversationTest(HeadCase):
    def test_opening_starts_the_head_session_without_asking_the_model(self):
        self.open()
        self.wait_for(lambda: self.claude_log.exists(), "the session never started")
        time.sleep(0.2)
        self.assertEqual(self.prompts(), [])

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

    def test_an_end_phrase_signs_off_without_a_model_call(self):
        conv = self.open()
        sentences, done = self.turn(conv, "Okay, that's all.")
        self.assertEqual(len(sentences), 1)
        self.assertTrue(done["end_conversation"])
        self.assertEqual(self.prompts(), [])

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
        self.turn(conv, "never mind")
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
