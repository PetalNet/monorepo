"""turn_end.py with a scripted stand-in for the speech model: what a speaker would notice."""

import io
import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import turn_end  # noqa: E402
from turn_end import FRAME, FRAME_S, RATE, Policy, Silero, To16k, TurnEnd, frames  # noqa: E402

SPEECH, SILENCE = np.ones(FRAME, np.float32), np.zeros(FRAME, np.float32)


def listen(steps, policy=Policy()):
    """Feeds (seconds, frame) steps; returns (why it ended, seconds heard)."""
    turn_end = TurnEnd(lambda frame: float(frame[0]), policy)
    heard = 0
    for seconds, frame in steps:
        for _ in range(round(seconds / FRAME_S)):
            heard += 1
            if why := turn_end.feed(frame):
                return why, heard * FRAME_S
    return None, heard * FRAME_S


QUIET_S = Policy().quiet_s


class TurnEndTest(unittest.TestCase):
    def test_a_turn_ends_once_the_speaker_has_been_quiet_long_enough(self):
        why, seconds = listen([(2.0, SPEECH), (10.0, SILENCE)])
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + QUIET_S, delta=0.1)

    def test_someone_who_pauses_to_think_and_goes_on_is_heard_to_the_end(self):
        thinking = [(3.0, SPEECH), (QUIET_S - 0.3, SILENCE)] * 20
        why, seconds = listen(thinking + [(10.0, SILENCE)])
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 20 * (3.0 + QUIET_S - 0.3) + 0.3, delta=0.2)

    def test_the_briefest_speech_in_a_silence_keeps_the_turn_open(self):
        steps = [(2.0, SPEECH), (QUIET_S - 0.5, SILENCE), (FRAME_S, SPEECH), (10.0, SILENCE)]
        why, seconds = listen(steps)
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + QUIET_S - 0.5 + QUIET_S, delta=0.1)

    def test_a_click_is_not_a_turn_and_nothing_said_gives_up(self):
        why, seconds = listen([(1.0, SILENCE), (0.09, SPEECH), (10.0, SILENCE)])
        self.assertEqual(why, "nothing said")
        self.assertAlmostEqual(seconds, 6.0, delta=0.1)

    def test_however_long_the_speaker_waits_to_begin_the_turn_gets_its_full_silence(self):
        why, seconds = listen([(5.5, SILENCE), (1.0, SPEECH), (10.0, SILENCE)])
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 6.5 + QUIET_S, delta=0.1)


class AudioTest(unittest.TestCase):
    def tone(self, rate, seconds=1.0):
        return np.sin(2 * np.pi * 440 * np.arange(int(rate * seconds)) / rate).astype(np.float32)

    def test_a_48_khz_stream_in_ragged_chunks_comes_out_as_the_same_sound_at_16_khz(self):
        class Ragged(io.BytesIO):
            def read1(self, size=-1):
                return super().read(1237)  # not a whole number of samples

        heard = np.concatenate(list(frames(Ragged(self.tone(48000).tobytes()), 48000)))
        self.assertAlmostEqual(len(heard) / RATE, 1.0, delta=2 * FRAME_S)
        settled = heard[1600:]
        spectrum = np.abs(np.fft.rfft(settled))
        self.assertAlmostEqual(np.argmax(spectrum) * RATE / len(settled), 440, delta=2)
        self.assertAlmostEqual(float(np.sqrt(np.mean(settled**2))), 2**-0.5, delta=0.01)

    def test_a_16_khz_stream_passes_through_untouched(self):
        tone = self.tone(RATE)
        heard = np.concatenate(list(frames(io.BytesIO(tone.tobytes()), RATE)))
        np.testing.assert_array_equal(heard, tone[: len(heard)])

    def test_a_44_1_khz_stream_comes_out_the_same_however_it_is_cut_into_chunks(self):
        sound = np.random.default_rng(1).standard_normal(44100).astype(np.float32)
        whole = To16k(44100)(sound)
        to_16k = To16k(44100)
        pieces = np.concatenate([to_16k(piece) for piece in np.split(sound, [7, 1000, 1001, 20000, 20003])])
        np.testing.assert_allclose(pieces, whole, atol=1e-6)
        self.assertAlmostEqual(len(whole), RATE, delta=40)

    def test_reads_too_short_to_hold_a_sample_add_nothing_to_the_sound(self):
        class Dribble(io.BytesIO):
            def read1(self, size=-1):
                self.turn = getattr(self, "turn", 0) + 1
                return super().read(3 if self.turn % 2 else 5001)

        tone = self.tone(48000)
        ragged = np.concatenate(list(frames(Dribble(tone.tobytes()), 48000)))
        clean = np.concatenate(list(frames(io.BytesIO(tone.tobytes()), 48000)))
        np.testing.assert_allclose(ragged, clean[: len(ragged)], atol=1e-6)

    def test_silero_is_given_its_own_memory_and_the_end_of_the_frame_before(self):
        class Model:
            calls = []

            def run(self, _, inputs):
                self.calls.append(inputs)
                return np.array([[0.7]], np.float32), inputs["state"] + 1

        with mock.patch.object(turn_end, "_session", return_value=Model()):
            vad = Silero(Path("unused"))
        first, second = np.full(FRAME, 0.1, np.float32), np.full(FRAME, 0.2, np.float32)
        self.assertAlmostEqual(vad(first), 0.7, places=6)
        vad(second)
        heard = Model.calls[1]
        np.testing.assert_array_equal(heard["input"][0], np.concatenate([first[-64:], second]))
        self.assertTrue((heard["state"] == 1).all())


if __name__ == "__main__":
    unittest.main()
