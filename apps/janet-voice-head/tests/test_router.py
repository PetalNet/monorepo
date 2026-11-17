import time
import unittest

from janet_voice_head import router
from tests.harness import HeadCase


class ClassifyTest(unittest.TestCase):
    def test_rules_pick_the_lane_without_a_model(self):
        for text, lane in [
            ("What time is it?", "clock"), ("hey Janet, what's the date", "clock"),
            ("turn off the desk lights", "home"), ("set a timer for ten minutes", "home"),
            ("what did I tell you about Friday", "fork"), ("send a text to Sam", "fork"), ("remind me to call mom", "fork"),
            ("do I have anything tomorrow", "fork"), ("who emailed me", "fork"), ("what did we talk about", "fork"),
            ("is the front door locked", "home"), ("turn off my desk lights", "home"), ("set a reminder for five", "fork"),
            ("who wrote Dune", "fast"), ("tell me a joke", "fast"),
        ]:
            self.assertEqual(router.classify(text), lane, text)

    def test_the_clock_answer_is_the_local_time(self):
        self.assertIn(time.strftime("%-I:%M"), router.clock_answer("what time is it"))
        self.assertIsNone(router.clock_answer("what time does the library open"))


class EscalationFilterTest(unittest.TestCase):
    def test_the_marker_is_removed_even_when_split_across_deltas(self):
        mark, out = router.EscalationFilter(), ""
        for delta in ["<esc", "alate", "/> Checking. Then more."]:
            out += mark.feed(delta)
        out += mark.finish()
        self.assertTrue(mark.escalated)
        self.assertEqual(out.strip(), "Checking.")

    def test_nothing_after_the_marker_is_spoken(self):
        mark = router.EscalationFilter()
        self.assertEqual(mark.feed("<escalate/> Checking. Actually it is five."), " Checking. ")
        self.assertEqual(mark.feed("More."), "")

    def test_text_that_only_looks_like_the_marker_is_spoken(self):
        mark = router.EscalationFilter()
        out = mark.feed("a < b and <es") + mark.finish()
        self.assertFalse(mark.escalated)
        self.assertEqual(out, "a < b and <es")


class RoutedTurnTest(HeadCase):
    overrides = {"router": True, "hub_forks": False}

    def test_the_clock_is_answered_with_no_model_call(self):
        sentences, done = self.turn(self.open(), "what time is it")
        self.assertEqual(done["latency_ms"]["route"], "clock")
        self.assertEqual(len(sentences), 1)
        self.assertEqual([p for p in self.prompts() if "Parker says" in p], [])

    def test_chat_is_answered_by_the_fast_lane_and_never_touches_the_fork(self):
        sentences, done = self.turn(self.open(), "who wrote dune")
        self.assertEqual(sentences, ["Fast says who wrote dune."])
        self.assertEqual(done["latency_ms"]["route"], "fast")
        self.assertFalse(any("voice head turn" in p.lower() for p in self.prompts()))

    def test_memory_questions_say_a_filler_then_the_fork_answers(self):
        sentences, done = self.turn(self.open(), "what did I tell you about order")
        self.assertEqual(sentences[0], router.FILLER)
        self.assertEqual(done["latency_ms"]["route"], "fork")
        self.assertTrue(any("Voice head turn" in p for p in self.prompts()))

    def test_the_fast_lane_can_hand_a_turn_up_after_its_own_acknowledgment(self):
        sentences, _ = self.turn(self.open(), "escalateme please")
        self.assertEqual(sentences[0], "Checking on that.")
        self.assertTrue(any("Voice head turn" in p for p in self.prompts()))
        self.assertFalse(any("<escalate" in s for s in sentences))

    def test_the_fork_hears_what_was_answered_without_it(self):
        conv = self.open()
        self.turn(conv, "who wrote dune")
        self.turn(conv, "what did I tell you about order")
        fork_prompt = next(p for p in self.prompts() if "Voice head turn" in p)
        self.assertIn("who wrote dune", fork_prompt)
        self.assertIn("Fast says who wrote dune.", fork_prompt)

    def test_a_relay_only_fork_reply_after_the_filler_still_gets_a_spoken_answer(self):
        sentences, _ = self.turn(self.open(), "send onlyrelay")
        self.assertEqual(sentences[0], router.FILLER)
        self.assertEqual(sentences[-1], "Okay, I will pass that to main Janet.")

    def test_guests_never_use_the_fast_lane(self):
        sentences, _ = self.turn(self.open("guest"), "who wrote dune")
        self.assertEqual(sentences[0], "You said who wrote dune.")


class HubForkTest(HeadCase):
    overrides = {"router": True}

    def test_a_personal_conversation_uses_a_hub_fork_and_launches_no_local_fork(self):
        conv = self.open()
        sentences, done = self.turn(conv, "send me a note about today")
        self.assertEqual(sentences, [router.FILLER, "Fork heard send me a note about today.", "That is the fork."])
        self.assertEqual(done["latency_ms"]["route"], "fork")
        self.assertTrue(self.hub.asks[-1]["stream"] and self.hub.asks[-1]["sentences"] and self.hub.asks[-1]["speaker"]["verified"])
        self.assertFalse(any("--resume" in launch["argv"] for launch in self.launches()))

    def test_conversations_close_together_share_one_warm_fork(self):
        first = self.open()
        self.turn(first, "send me a note")
        self.end(first)
        second = self.open()
        self.turn(second, "send me another note")
        self.assertEqual(len(self.hub.forks), 1)
        self.assertEqual(self.hub.asks[-1]["node"], self.hub.asks[0]["node"])
        self.assertEqual(self.hub.asks[0]["text"].count("Warm-up"), 1)

    def test_the_head_never_merges_a_hub_fork_or_injects_into_main(self):
        conv = self.open()
        self.turn(conv, "send me a note")
        self.end(conv)
        self.assertEqual([call for call in self.hub.fork_calls if call[0] == "hard"], [])
        self.assertEqual(self.hub.accepted, [])

    def test_a_fork_the_hub_has_parked_is_replaced_once(self):
        conv = self.open()
        self.wait_for(lambda: self.hub.asks, "the fork was not warmed")
        self.hub.dead_forks.add("f1")
        sentences, _ = self.turn(conv, "send me a note")
        self.assertEqual(sentences[-1], "That is the fork.")

    def test_a_fork_turn_is_not_injected_into_main_at_all(self):
        self.turn(self.open(), "who wrote dune")
        self.assertEqual([m for m in self.hub.accepted if m["source"].startswith("voice-soft")], [])


if __name__ == "__main__":
    unittest.main()
