"""turn_end.py with scripted stand-ins for the two models: what a speaker would notice."""

import io
import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import turn_end  # noqa: E402
from turn_end import FRAME, FRAME_S, RATE, Policy, Silero, To16k, TurnEnd, frames, whisper_features  # noqa: E402

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
        why, seconds, asked = listen([(1.0, SILENCE), (0.09, SPEECH), (10.0, SILENCE)], finished=0.99)
        self.assertEqual((why, asked), ("nothing said", []))
        self.assertAlmostEqual(seconds, 6.0, delta=0.1)

    def test_the_briefest_speech_in_a_silence_keeps_the_turn_open(self):
        steps = [(2.0, SPEECH), (3.5, SILENCE), (FRAME_S, SPEECH), (10.0, SILENCE)]
        why, seconds, _ = listen(steps, finished=0.3)
        self.assertEqual(why, "quiet")
        self.assertAlmostEqual(seconds, 2.0 + 3.5 + 4.0, delta=0.1)

    def test_smart_turn_has_to_be_surer_than_the_threshold_not_merely_at_it(self):
        why, _, _ = listen([(2.0, SPEECH), (10.0, SILENCE)], finished=0.5, policy=Policy(asks=((1.0, 0.5),)))
        self.assertEqual(why, "quiet")

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

    def test_the_features_are_the_ones_whisper_computes(self):
        # A rising tone over a steady one, three seconds long. The expected values are what
        # transformers' WhisperFeatureExtractor(chunk_length=8) gives for it, front-padded.
        t = np.arange(3 * RATE) / RATE
        sound = (0.3 * np.sin(2 * np.pi * (200 + 300 * t) * t) + 0.1 * np.sin(2 * np.pi * 1500 * t)).astype(np.float32)
        features = whisper_features(sound)
        self.assertEqual(features.shape, (80, 800))
        for (mel, frame), expected in {(0, 0): -0.2087, (5, 520): 0.8456, (40, 650): 0.2402, (79, 799): 0.0587}.items():
            self.assertAlmostEqual(float(features[mel, frame]), expected, places=3)
        self.assertAlmostEqual(float(features.mean()), -0.1071, places=3)
        self.assertEqual(whisper_features(self.tone(RATE, 12.0)).shape, (80, 800))

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
