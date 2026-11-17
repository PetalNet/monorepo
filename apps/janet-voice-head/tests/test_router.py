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
    overrides = {"router": True}

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

    def test_guests_never_use_the_fast_lane(self):
        sentences, _ = self.turn(self.open("guest"), "who wrote dune")
        self.assertEqual(sentences[0], "You said who wrote dune.")


if __name__ == "__main__":
    unittest.main()
