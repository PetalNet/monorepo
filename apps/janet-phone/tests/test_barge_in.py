import math
import struct
import unittest

from barge_in import BargeIn


def speech(amplitude=4000, offset=0):
    return b"".join(struct.pack("<h", round(amplitude * (math.sin((i + offset) * .13)
                     + math.sin((i + offset) * .067)) / 2)) for i in range(512))


class BargeInTest(unittest.TestCase):
    def test_without_speech_model_noise_cannot_interrupt(self):
        gate = BargeIn()
        for i in range(100):
            self.assertFalse(gate.feed(speech(600), protected=False, now=i * .032))

    def test_first_sentence_and_generation_are_protected_from_sustained_speech(self):
        gate = BargeIn(lambda _: .99)
        for i in range(100):
            self.assertFalse(gate.feed(speech(), protected=True, now=i * .032))

    def test_short_burst_and_background_speech_do_not_interrupt(self):
        for frames, amplitude in ((5, 4000), (100, 120)):
            gate = BargeIn(lambda _: .99)
            for i in range(frames):
                self.assertFalse(gate.feed(speech(amplitude), protected=False, now=i * .032))

    def test_sustained_foreground_speech_interrupts_after_first_sentence(self):
        gate = BargeIn(lambda _: .99)
        results = [gate.feed(speech(), protected=False, now=i * .032) for i in range(20)]
        self.assertFalse(any(results[:14]))
        self.assertTrue(any(results[14:]))

    def test_brief_syllable_gaps_still_allow_sustained_speech(self):
        probabilities = iter([.99, .99, .99, .99, .1] * 5)
        gate = BargeIn(lambda _: next(probabilities))
        results = [gate.feed(speech(), protected=False, now=i * .032) for i in range(25)]
        self.assertTrue(any(results))

    def test_split_packets_preserve_the_speech_window(self):
        gate = BargeIn(lambda _: .99)
        results = []
        for i in range(20):
            frame = speech()
            results.append(gate.feed(frame[:200], protected=False, now=i * .032))
            results.append(gate.feed(frame[200:], protected=False, now=i * .032))
        self.assertTrue(any(results))
        self.assertEqual(gate.pending, b"")

    def test_queued_audio_cannot_supply_wall_clock_evidence(self):
        gate = BargeIn(lambda _: .99)
        self.assertFalse(gate.feed(speech() * 100, protected=False, now=1))
        self.assertFalse(gate.feed(speech(), protected=False, now=2))

    def test_an_old_frame_does_not_lend_clock_time_to_a_later_burst(self):
        gate = BargeIn(lambda _: .99)
        self.assertFalse(gate.feed(speech(), protected=False, now=0))
        self.assertFalse(gate.feed(bytes(1024), protected=False, now=.24))
        self.assertFalse(gate.feed(speech() * 15, protected=False, now=.48))

    def test_paced_hundred_ms_packets_can_interrupt(self):
        gate = BargeIn(lambda _: .99)
        results = [gate.feed(speech() * 3, protected=False, now=i * .096) for i in range(8)]
        self.assertTrue(any(results))

    def test_delayed_scaled_playback_is_not_caller_speech(self):
        import numpy as np

        gate = BargeIn(lambda _: .99)
        rng = np.random.default_rng(15)
        playback = np.clip(rng.normal(0, 2500, 16000), -20000, 20000).astype("<i2")
        gate.played(playback.tobytes(), 16000, 0)
        for i in range(20):
            echo = (playback[i * 512:(i + 1) * 512] * .7).astype("<i2").tobytes()
            self.assertFalse(gate.feed(echo, protected=False, now=i * .032))
        self.assertGreater(gate.status["correlation"], .99)
        residual = np.frombuffer(gate.caller_audio, "<i2").astype(np.float32)
        self.assertLess(float(np.sqrt(np.mean(residual * residual))), 2)

    def test_a_quieter_caller_is_retained_under_louder_echo(self):
        import numpy as np

        gate = BargeIn(lambda _: .99)
        rng = np.random.default_rng(17)
        playback = rng.normal(0, 6000, 16000).astype("<i2")
        gate.played(playback.tobytes(), 16000, 0)
        caller = np.frombuffer(speech(500), "<i2")
        mixed = (caller + playback[:512]).astype("<i2").tobytes()
        gate.feed(mixed, protected=True, now=.1)
        remaining = np.frombuffer(gate.caller_audio, "<i2").astype(np.float32)
        self.assertGreater(float(np.sqrt(np.mean(remaining * remaining))), 100)
        self.assertGreater(float(np.corrcoef(remaining, caller)[0, 1]), .95)
        self.assertTrue(gate.status["first_sentence_protected"])

    def test_caller_above_echo_can_interrupt(self):
        import numpy as np

        gate = BargeIn(lambda _: .99)
        rng = np.random.default_rng(16)
        playback = rng.normal(0, 300, 16000).astype("<i2")
        gate.played(playback.tobytes(), 16000, 0)
        results = []
        for i in range(20):
            caller = np.frombuffer(speech(offset=i * 512), "<i2")
            mixed = (caller + playback[i * 512:(i + 1) * 512]).astype("<i2").tobytes()
            results.append(gate.feed(mixed, protected=False, now=i * .032))
        self.assertTrue(any(results))
