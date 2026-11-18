import unittest

from janet_voice_head.speech import SpeechStream, is_backchannel


def run(text: str, step: int | None = None) -> tuple[list[str], list[str], list[str], str]:
    stream, spoken = SpeechStream(), []
    chunks = [text] if step is None else [text[i:i + step] for i in range(0, len(text), step)]
    for chunk in chunks:
        spoken += stream.feed(chunk)
    spoken += stream.finish()
    return spoken, stream.relay.asks, stream.relay.commitments, stream.spoken


class RelayParsingTest(unittest.TestCase):
    def test_every_relay_block_is_parsed_and_the_text_after_each_is_spoken(self):
        text = "Okay.\n<relay>\nask: first thing\n</relay>\nAlso noted.\n<relay>\nask: second thing\ncommitment: it will be done\n</relay>\nDone."
        for step in (None, 1, 3, 7):
            spoken, asks, commitments, whole = run(text, step)
            self.assertEqual(spoken, ["Okay.", "Also noted.", "Done."], step)
            self.assertEqual((asks, commitments), (["first thing", "second thing"], ["it will be done"]), step)
            self.assertEqual(whole, "Okay. Also noted. Done.")

    def test_tag_case_and_bracket_variants_are_relay_blocks(self):
        for text in ("Sure.\n<RELAY>\nask: a\n</RELAY>", "Sure.\n[relay]\nask: a\n[/relay]", "Sure.\n<Relay>\nask: a\n</relay>"):
            for step in (None, 2):
                spoken, asks, _, whole = run(text, step)
                self.assertEqual((spoken, asks, whole), (["Sure."], ["a"], "Sure."), (text, step))

    def test_a_reply_that_opens_with_a_relay_speaks_what_follows(self):
        spoken, asks, _, whole = run("<relay>\nask: do it\n</relay>\nSure thing.", 4)
        self.assertEqual((spoken, asks, whole), (["Sure thing."], ["do it"], "Sure thing."))

    def test_an_unclosed_block_is_relay_and_never_spoken(self):
        spoken, asks, _, whole = run("Sure.\n<relay>\nask: do it", 5)
        self.assertEqual((spoken, asks, whole), (["Sure."], ["do it"], "Sure."))

    def test_text_that_only_looks_like_a_tag_is_still_spoken(self):
        spoken, asks, _, _ = run("Is 2 < 3? Yes.", 2)
        self.assertEqual((spoken, asks), (["Is 2 < 3?", "Yes."], []))


if __name__ == "__main__":
    unittest.main()


class BackchannelTest(unittest.TestCase):
    def test_filler_that_only_says_the_line_is_open_is_not_spoken(self):
        for text in ("Go ahead, I'm listening.", "Go ahead.", "Mm-hm.", "I'm listening, Parker.", "Take your time.", "[silent]"):
            spoken, _, _, whole = run(text)
            self.assertEqual((spoken, whole), ([], ""), text)

    def test_an_answer_that_uses_the_same_words_is_spoken(self):
        for text in ("Okay.", "Yes.", "Sure, go ahead.", "Yes, I hear you.", "Okay, I'm ready.", "Go ahead and order the filament.", "I'm here to help with store hours."):
            self.assertEqual(run(text)[0], [text], text)

    def test_filler_before_a_real_answer_is_dropped_and_the_answer_kept(self):
        spoken, _, _, whole = run("Go ahead, I'm listening. The store closes at nine.", 5)
        self.assertEqual((spoken, whole), (["The store closes at nine."], "The store closes at nine."))


class CutOffNoteTest(unittest.TestCase):
    def test_a_barge_in_is_named_as_deliberate_and_says_what_was_heard(self):
        from janet_voice_head import prompts
        note = prompts.turn_prompt("next", fork=True, cut_off="It closes at")
        self.assertIn("Parker started talking over your last reply, on purpose", note)
        self.assertIn('Only this much was heard: "It closes at"', note)
        self.assertIn("Do not apologize or repeat it", note)
        self.assertNotIn("started talking", prompts.turn_prompt("next", fork=True, cut_off=None))
        self.assertIn("The speaker started talking", prompts.turn_prompt("next", fork=False, cut_off=""))
