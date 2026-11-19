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
        for text in ("Go ahead, I'm listening.", "Go ahead.", "I'm listening, Parker.", "Take your time.", "[silent]"):
            spoken, _, _, whole = run(text)
            self.assertEqual((spoken, whole), ([], ""), text)

    def test_an_answer_that_uses_the_same_words_is_spoken(self):
        for text in ("Mm.", "Mm-hm.", "Hmm.", "Uh-huh.", "Okay.", "Yes.", "Sure, go ahead.", "Yes, I hear you.", "Okay, I'm ready.", "Go ahead and order the filament.", "I'm here to help with store hours."):
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


class EndPhraseTest(unittest.TestCase):
    def test_a_clear_goodbye_or_hang_up_ends_the_call(self):
        from janet_voice_head.speech import is_end_phrase

        for text in ("Hang up.", "hang up now", "Please hang up", "End the call.", "Okay, end call", "Bye Janet", "That's all, thank you", "Okay, goodbye."):
            self.assertTrue(is_end_phrase(text), text)

    def test_an_ambiguous_phrase_never_does(self):
        from janet_voice_head.speech import is_end_phrase

        for text in ("don't hang up", "can you hang up the call on the other line", "hang up on him", "end the call after you check the store hours",
                     "stop", "I'm not done", "that's not all", "wait", "how do I hang up", "the call ended badly", "Go ahead and hang up when I say bye"):
            self.assertFalse(is_end_phrase(text), text)


class StatusRuleTest(unittest.TestCase):
    def test_a_fork_is_told_it_cannot_see_mains_work_and_must_never_state_a_cause(self):
        from janet_voice_head import prompts

        for text in (prompts.turn_prompt("how is the research going", fork=True, cut_off=None),
                     prompts.turn_prompt("how is the research going", fork=True, cut_off=None, web=("WebSearch",))):
            self.assertIn("cannot see main Janet's background work", text)
            self.assertIn("Never state a cause or an outcome you did not see", text)
            self.assertIn("will have main check", text)


class ClauseTest(unittest.TestCase):
    TEXT = "Doing well, thanks for asking, and honestly I'm just glad to hear from you tonight, so what is on your mind? Short one."

    def test_a_long_sentence_is_cut_at_a_comma_as_it_streams_so_the_first_sound_starts_early(self):
        for step in (1, 3, 7):
            spoken, _, _, whole = run(self.TEXT, step)
            self.assertEqual(spoken[0], "Doing well, thanks for asking,", step)
            self.assertEqual(" ".join(spoken), self.TEXT, step)  # nothing is lost or reordered

    def test_a_short_sentence_or_one_without_a_comma_is_not_cut(self):
        for text in ("Yes, that works fine for me.", "A long sentence with no comma in it at all but plenty of words so it runs past the limit easily."):
            for step in (1, 4):
                self.assertEqual(run(text, step)[0], [text], (text, step))

    def test_the_first_piece_of_a_cut_sentence_is_never_shorter_than_the_minimum(self):
        spoken, *_ = run("Well, ok, so, then, there it is and that is how it goes for a long time now, sure.", 2)
        self.assertTrue(all(len(piece) >= 28 for piece in spoken[:-1]), spoken)
