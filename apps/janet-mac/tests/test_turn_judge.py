"""The turn judge with scripted speech: what a speaker would notice at a pause."""

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import turn_end  # noqa: E402
from turn_end import FRAME, FRAME_S, Policy, TurnEnd  # noqa: E402
from turn_judge import Hearing, Judge, cues, filled  # noqa: E402

SPEECH, SILENCE = np.ones(FRAME, np.float32), np.zeros(FRAME, np.float32)
POLICY = Policy()
FITTED = Path(__file__).resolve().parent.parent / "turn_judge.json"


class Scripted:
    """Stands in for turn_judge.Hearing: gives the same verdict at every pause."""

    def __init__(self, verdict):
        self._verdict = verdict

    def hear(self, frame, said):
        pass

    def verdict(self, silent):
        return self._verdict


def listen(steps, hearing):
    turn = TurnEnd(lambda frame: float(frame[0]), POLICY, hearing)
    heard = 0
    for seconds, frame in steps:
        for _ in range(round(seconds / FRAME_S)):
            heard += 1
            if why := turn.feed(frame):
                return why, heard * FRAME_S
    return None, heard * FRAME_S


def said(text, pause_s=0.0, um_s=0.0):
    """A turn in which `text` was spoken at three words a second, then an unworded sound, then a pause."""
    words = text.split()
    spoken = round((len(words) / 3 + um_s) / FRAME_S)
    pieces = [("▁" + word, i / 3) for i, word in enumerate(words)]
    speech = [True] * spoken + [False] * round(pause_s / FRAME_S)
    return cues(speech, [0.0] * len(speech), [-30.0] * len(speech), pieces, False, spoken)


class TurnEndWithAJudgeTest(unittest.TestCase):
    def test_a_speaker_judged_done_is_answered_after_a_second(self):
        why, seconds = listen([(2.0, SPEECH), (10.0, SILENCE)], Scripted("done"))
        self.assertEqual(why, "done")
        self.assertAlmostEqual(seconds, 2.0 + POLICY.judge_at_s[0], delta=0.1)

    def test_with_no_call_from_the_judge_the_turn_waits_out_the_full_silence(self):
        why, seconds = listen([(2.0, SPEECH), (10.0, SILENCE)], Scripted(None))
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + POLICY.quiet_s, delta=0.1)

    def test_after_an_um_the_turn_stays_open_well_past_the_usual_silence(self):
        why, seconds = listen([(2.0, SPEECH), (20.0, SILENCE)], Scripted("hold"))
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + POLICY.hold_s, delta=0.1)

    def test_someone_who_goes_on_after_an_um_gets_the_usual_silence_at_the_next_pause(self):
        class UmThenNothing(Scripted):
            def verdict(self, silent):
                self._verdict, was = None, self._verdict
                return was

        steps = [(2.0, SPEECH), (4.0, SILENCE), (2.0, SPEECH), (20.0, SILENCE)]
        why, seconds = listen(steps, UmThenNothing("hold"))
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 8.0 + POLICY.quiet_s, delta=0.1)

    def test_without_the_judge_installed_listening_goes_by_silence_alone(self):
        with tempfile.TemporaryDirectory() as models:
            self.assertIsNone(turn_end.hearing(Path(models)))

    def test_a_speech_model_that_never_loads_gives_no_call(self):
        with tempfile.TemporaryDirectory() as models:
            hearing = Hearing(Path(models), FITTED)  # no model there: its thread dies
            why, seconds = listen([(2.0, SPEECH), (10.0, SILENCE)], hearing)
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + POLICY.quiet_s, delta=0.1)


class CuesTest(unittest.TestCase):
    def test_a_trailing_and_means_more_is_coming(self):
        self.assertTrue(filled(said("we could move it to the other server and")))

    def test_a_sound_the_speech_model_wrote_no_word_for_is_a_filled_pause(self):
        self.assertTrue(filled(said("i was thinking we could", um_s=0.9)))
        self.assertTrue(filled(said("we could move it um")))

    def test_a_finished_sentence_is_not_a_filled_pause(self):
        self.assertFalse(filled(said("what time does the lounge open")))

    def test_a_sound_with_no_word_heard_at_all_is_not_called_an_um(self):
        self.assertFalse(filled(said("", um_s=1.0)))

    def test_a_short_question_is_surer_than_the_middle_of_a_long_ramble(self):
        judge = Judge(FITTED)
        question = said("what time does the lounge open please")
        ramble = cues([True] * 1500 + [False] * 40 + [True] * 300, [0.0] * 1840, [-30.0] * 1840,
                      [("▁word", i / 3) for i in range(150)] + [("▁thing", 58.0)], False, 1840)  # fmt: skip
        self.assertGreater(judge.done(question), judge.done(ramble))
        self.assertEqual(question["short_asking"], 1.0)


if __name__ == "__main__":
    unittest.main()
