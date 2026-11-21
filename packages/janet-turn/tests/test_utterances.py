"""Utterances: a stream of call audio split into turns, with a stand-in for the speech detector and no judge."""

import sys
import unittest
from unittest import mock
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from janet_turn.turn_end import FRAME, Policy, Utterances  # noqa: E402

RATE = 16000


def tone(seconds: float) -> bytes:
    n = int(RATE * seconds)
    return (np.sin(np.arange(n) / 8) * 8000).astype("<i2").tobytes()


def silence(seconds: float) -> bytes:
    return bytes(int(RATE * seconds) * 2)


class Loudness:
    """Says a frame is speech when it is loud: the shape of Silero's call, without the model."""

    def __call__(self, frame: np.ndarray) -> float:
        return 1.0 if float(np.abs(frame).max()) > 0.05 else 0.0


def utterances(**kw) -> Utterances:
    return Utterances(Path("."), Policy(nothing_said_s=1e9, quiet_s=kw.pop("quiet_s", 3.0)), make_vad=Loudness, make_hearing=lambda: None, **kw)


def run(audio: bytes, **kw) -> list:
    out, u = [], utterances(**kw)
    for i in range(0, len(audio), 3200):  # 100 ms chunks, as a phone sends
        out += u.feed(audio[i : i + 3200])
    return out


class UtterancesTest(unittest.TestCase):
    def test_speech_then_enough_quiet_is_one_utterance_after_a_start(self):
        events = run(silence(0.5) + tone(1.0) + silence(3.5))
        self.assertEqual(events[0], "start")
        (utterance,) = [e for e in events if isinstance(e, bytes)]
        self.assertGreaterEqual(len(utterance), len(tone(1.0)))

    def test_a_pause_shorter_than_the_quiet_does_not_split_a_turn(self):
        events = run(silence(0.5) + tone(1.0) + silence(1.4) + tone(1.0) + silence(3.5))
        self.assertEqual(len([e for e in events if isinstance(e, bytes)]), 1)
        self.assertEqual(events.count("start"), 1)

    def test_two_turns_are_two_utterances_each_with_its_own_start(self):
        events = run(tone(1.0) + silence(3.5) + tone(1.0) + silence(3.5))
        self.assertEqual(events.count("start"), 2)
        self.assertEqual(len([e for e in events if isinstance(e, bytes)]), 2)

    def test_silence_alone_is_no_utterance(self):
        self.assertEqual(run(silence(10.0)), [])

    def test_network_gap_does_not_complete_a_pause(self):
        detector = utterances(quiet_s=.3)
        self.assertEqual(detector.feed(tone(.3) + silence(.2)), ["start"])
        detector.gap()
        self.assertEqual(detector.feed(silence(.2)), [])
        events = detector.feed(tone(.3) + silence(.4))
        self.assertEqual(len([event for event in events if isinstance(event, bytes)]), 1)
        endpoint = detector.endpoints.popleft()
        self.assertGreaterEqual(endpoint["endpoint_ms"], 300)
        self.assertGreaterEqual(endpoint["speech_ms"], 500)

    def test_long_idle_does_not_load_or_feed_the_speech_model(self):
        heard = mock.Mock()
        make_hearing = mock.Mock(return_value=heard)
        detector = Utterances(Path("."), make_vad=Loudness, make_hearing=make_hearing)
        self.addCleanup(detector.close)
        for _ in range(120):
            self.assertEqual(detector.feed(silence(1)), [])
        make_hearing.assert_not_called()
        self.assertEqual(detector.feed(tone(.2)), ["start"])
        make_hearing.assert_called_once()
        # Only the retained lead-in and speech onset reach the newly started model.
        self.assertLess(heard.hear.call_count * FRAME / RATE, .6)
        self.assertGreater(heard.hear.call_count, round(.2 * RATE / FRAME))

    def test_short_safety_limit_never_emits_idle_audio(self):
        self.assertEqual(run(silence(2), max_s=.3), [])

    def test_a_turn_that_never_ends_is_cut_at_the_longest(self):
        events = run(tone(5.0), max_s=2.0)
        self.assertTrue(any(isinstance(e, bytes) for e in events))


if __name__ == "__main__":
    unittest.main()
