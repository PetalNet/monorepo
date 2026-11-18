"""The turn judge with scripted speech: what a speaker would notice at a pause."""

import io
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

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


def stopped(hearing):
    """Waits for a failing speech model's thread to give up."""
    for _ in range(200):
        if hearing._frames is None:
            return
        time.sleep(0.05)


def said(text, pause_s=0.0, um_s=0.0):
    """A turn in which `text` was spoken at three words a second, then an unworded sound, then a pause."""
    words = text.split()
    spoken = round((len(words) / 3 + um_s) / FRAME_S)
    pieces = [("▁" + word, i / 3) for i, word in enumerate(words)]
    speech = [True] * spoken + [False] * round(pause_s / FRAME_S)
    return cues(speech, pieces, False, spoken)


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

    def test_a_judge_that_says_done_after_an_um_is_not_believed_in_that_pause(self):
        class UmThenDone(Scripted):
            def verdict(self, silent):
                self._verdict, was = "done", self._verdict
                return was

        why, seconds = listen([(2.0, SPEECH), (20.0, SILENCE)], UmThenDone("hold"))
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + POLICY.hold_s, delta=0.1)

    def test_a_judge_that_breaks_is_dropped_and_the_turn_ends_on_silence(self):
        class Broken(Scripted):
            def verdict(self, silent):
                raise KeyError("a cue the fitted model names is missing")

        with mock.patch("sys.stderr", io.StringIO()) as said_why:
            why, seconds = listen([(2.0, SPEECH), (10.0, SILENCE)], Broken(None))
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + POLICY.quiet_s, delta=0.1)
        self.assertIn("turn judge dropped", said_why.getvalue())

    def test_without_the_judge_s_files_listening_goes_by_silence_alone(self):
        with tempfile.TemporaryDirectory() as models:
            self.assertIsNone(turn_end.hearing(Path(models)))

    def test_with_turn_end_installed_alone_listening_goes_by_silence_alone(self):
        # An install that copied turn_end.py and not turn_judge.py: the import fails.
        with tempfile.TemporaryDirectory() as models, mock.patch.dict(sys.modules, {"turn_judge": None}):
            with mock.patch("sys.stderr", io.StringIO()) as said_why:
                self.assertIsNone(turn_end.hearing(Path(models)))
        self.assertIn("no turn judge", said_why.getvalue())

    def test_a_speech_model_that_fails_to_load_gives_no_call_and_holds_no_audio(self):
        with tempfile.TemporaryDirectory() as models, mock.patch("sys.stderr", io.StringIO()) as said_why:
            hearing = Hearing(Path(models), FITTED)  # no model there
            stopped(hearing)
            why, seconds = listen([(2.0, SPEECH), (10.0, SILENCE)], hearing)
        self.assertIsNone(hearing._frames)
        self.assertIn("no turn judge", said_why.getvalue())
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + POLICY.quiet_s, delta=0.1)

    def test_a_speech_model_that_fails_mid_turn_gives_no_more_calls(self):
        class FailsOnTheThirdChunk:
            def __init__(self, *_):
                self.calls = 0

            def __call__(self, chunk):
                self.calls += 1
                if self.calls == 3:
                    raise RuntimeError("the model stopped")
                return [("\u2581please", 0.1)], True

        with mock.patch("turn_judge.Words", FailsOnTheThirdChunk), mock.patch("sys.stderr", io.StringIO()):
            hearing = Hearing(Path("."), FITTED)
            why, seconds = listen([(2.0, SPEECH), (10.0, SILENCE)], hearing)
            stopped(hearing)
        self.assertIsNone(hearing._frames)
        self.assertEqual(why, "quiet")

    def test_a_speech_model_that_keeps_up_lets_a_short_request_end_early(self):
        class HearsAShortRequest:
            def __init__(self, *_):
                self.calls = 0

            def __call__(self, chunk):
                self.calls += 1
                heard = [("\u2581what", 0.2), ("\u2581time", 0.5), ("\u2581is", 0.8), ("\u2581it", 1.1), ("\u2581please", 1.4)]
                return (heard if self.calls == 10 else []), self.calls == 16

        class KeepsUp(Hearing):
            def verdict(self, silent):
                for _ in range(200):  # the test feeds audio faster than real time
                    if self._frames.empty():
                        break
                    time.sleep(0.01)
                time.sleep(0.05)
                return super().verdict(silent)

        with mock.patch("turn_judge.Words", HearsAShortRequest):
            why, seconds = listen([(1.8, SPEECH), (10.0, SILENCE)], KeepsUp(Path("."), FITTED))
        self.assertEqual(why, "done")
        self.assertLess(seconds, 1.8 + POLICY.quiet_s - 0.4)


class CuesTest(unittest.TestCase):
    def test_a_trailing_and_means_more_is_coming(self):
        self.assertTrue(filled(said("we could move it to the other server and")))

    def test_a_short_answer_that_ends_on_so_is_not_held_open(self):
        answer = said("yeah i think so")
        self.assertFalse(filled(answer))
        self.assertEqual(answer["leading"], 1.0)

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
        speech = [True] * 1500 + [False] * 40 + [True] * 300
        ramble = cues(speech, [("\u2581word", i / 3) for i in range(150)] + [("\u2581thing", 58.0)], False, 1840)
        self.assertGreater(judge.done(question), judge.done(ramble))
        self.assertEqual(question["short_asking"], 1.0)


if __name__ == "__main__":
    unittest.main()
