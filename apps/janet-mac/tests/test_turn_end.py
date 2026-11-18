"""turn_end.py with scripted stand-ins for the two models: what a speaker would notice."""

import io
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from turn_end import FRAME, FRAME_S, RATE, Policy, TurnEnd, frames, whisper_features  # noqa: E402

SPEECH, SILENCE = np.ones(FRAME, np.float32), np.zeros(FRAME, np.float32)


def listen(steps, finished=0.0, policy=Policy()):
    """Feeds (seconds, frame) steps; returns (why it ended, seconds heard, times Smart Turn was asked)."""
    asked = []

    def smart_turn(audio):
        asked.append(len(audio) / RATE)
        return finished(len(asked)) if callable(finished) else finished

    turn_end = TurnEnd(lambda frame: float(frame[0]), smart_turn, policy)
    heard = 0
    for seconds, frame in steps:
        for _ in range(round(seconds / FRAME_S)):
            heard += 1
            if why := turn_end.feed(frame):
                return why, heard * FRAME_S, asked
    return None, heard * FRAME_S, asked


class TurnEndTest(unittest.TestCase):
    def test_a_turn_that_sounds_finished_ends_after_a_second_of_silence(self):
        why, seconds, _ = listen([(2.0, SPEECH), (10.0, SILENCE)], finished=0.99)
        self.assertEqual(why, "finished")
        self.assertAlmostEqual(seconds, 3.0, delta=0.1)

    def test_a_turn_that_sounds_unfinished_is_given_four_seconds_of_silence(self):
        why, seconds, asked = listen([(2.0, SPEECH), (10.0, SILENCE)], finished=0.3)
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 6.0, delta=0.1)
        self.assertEqual(len(asked), len(Policy().asks))

    def test_the_longer_the_silence_the_less_sure_smart_turn_has_to_be(self):
        why, seconds, _ = listen([(2.0, SPEECH), (10.0, SILENCE)], finished=0.93)
        self.assertEqual(why, "finished")
        self.assertAlmostEqual(seconds, 4.0, delta=0.1)

    def test_someone_who_pauses_to_think_and_goes_on_is_heard_to_the_end(self):
        thinking = [(3.0, SPEECH), (2.4, SILENCE)] * 20
        why, seconds, _ = listen(thinking + [(10.0, SILENCE)], finished=0.6)
        self.assertEqual(why, "finished")
        self.assertGreater(seconds, 20 * 5.4)

    def test_speech_after_a_pause_starts_the_asking_again(self):
        steps = [(2.0, SPEECH), (1.2, SILENCE), (2.0, SPEECH), (10.0, SILENCE)]
        why, seconds, asked = listen(steps, finished=lambda count: 0.99 if count > 1 else 0.0)
        self.assertEqual((why, len(asked)), ("finished", 2))
        self.assertAlmostEqual(seconds, 6.2, delta=0.1)

    def test_a_click_is_not_a_turn_and_nothing_said_gives_up(self):
        why, seconds, asked = listen([(1.0, SILENCE), (0.06, SPEECH), (10.0, SILENCE)], finished=0.99)
        self.assertEqual((why, asked), ("nothing said", []))
        self.assertAlmostEqual(seconds, 6.0, delta=0.1)

    def test_smart_turn_hears_at_most_the_last_eight_seconds(self):
        _, _, asked = listen([(20.0, SPEECH), (10.0, SILENCE)], finished=0.99)
        self.assertEqual(asked, [8.0])


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

    def test_smart_turn_is_given_eight_seconds_of_features_however_short_the_turn(self):
        self.assertEqual(whisper_features(self.tone(RATE, 0.5)).shape, (80, 800))
        self.assertEqual(whisper_features(self.tone(RATE, 12.0)).shape, (80, 800))


if __name__ == "__main__":
    unittest.main()
