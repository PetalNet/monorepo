import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from janet_line.tone import Biquad, LineTone, dbfs, parse_code  # noqa: E402

PARKER = "AL6 AT45 AW83 BC2 BL11 BR7 BF2 BO6 DL0 DW48 U37 V80"
RATE = 24000


def seconds(tone: LineTone, s: float, phase: str) -> np.ndarray:
    return tone.render(int(RATE * s), phase)


class CodeTest(unittest.TestCase):
    def test_parkers_code_parses_and_missing_keys_take_the_pages_defaults(self):
        v = parse_code(PARKER)
        self.assertEqual((v["AL"], v["AT"], v["AW"], v["BC"], v["BL"], v["BR"], v["BF"], v["BO"], v["DL"], v["DW"], v["U"], v["V"]),
                         (6, 45, 83, 2, 11, 7, 2, 6, 0, 48, 37, 80))
        self.assertEqual(parse_code("AL3")["V"], 80)
        self.assertEqual(parse_code("")["AL"], 8)

    def test_a_bad_code_is_refused(self):
        for code in ("ZZ4", "AL", "AL6 BC3", "al6"):
            with self.assertRaises(ValueError, msg=code):
                parse_code(code)


class FilterTest(unittest.TestCase):
    def test_lowpass_passes_dc_and_blocks_nyquist_and_highpass_the_reverse(self):
        low, high = Biquad("lowpass", 1000, RATE), Biquad("highpass", 1000, RATE)
        n = 4096
        self.assertAlmostEqual(abs(low.response(n)[0]), 1.0, places=3)
        self.assertLess(abs(low.response(n)[-1]), 0.01)
        self.assertLess(abs(high.response(n)[0]), 0.01)
        self.assertAlmostEqual(abs(high.response(n)[-1]), 1.0, places=2)

    def test_the_streaming_filter_matches_the_steady_state_response_on_a_loop(self):
        f = Biquad("lowpass", 800, RATE, 0.7)
        t = np.arange(RATE) / RATE
        x = np.sin(2 * np.pi * 200 * t) + 0.5 * np.sin(2 * np.pi * 3000 * t)
        y = f(np.tile(x, 3))[-RATE:]
        steady = np.fft.irfft(np.fft.rfft(x) * f.response(len(x)), len(x))
        self.assertLess(float(np.max(np.abs(y - steady))), 1e-3)


class LevelTest(unittest.TestCase):
    def test_the_hiss_at_parkers_level_is_about_minus_54_dbfs_as_measured_on_the_page(self):
        tone = LineTone(PARKER, RATE)
        x = seconds(tone, 6, "listening")
        for channel in (0, 1):
            self.assertAlmostEqual(dbfs(x[:, channel]), -54.0, delta=1.5)

    def test_zero_levels_are_silent_and_the_master_scales_everything(self):
        self.assertEqual(float(np.abs(seconds(LineTone("AL0 DL0 BL0", RATE), 1, "listening")).max()), 0.0)
        loud, quiet = LineTone("AL20 V80", RATE), LineTone("AL20 V40", RATE)
        self.assertAlmostEqual(dbfs(seconds(loud, 3, "listening")) - dbfs(seconds(quiet, 3, "listening")), 6.02, delta=0.1)

    def test_the_room_tone_is_off_at_level_zero_and_audible_above(self):
        off, on = LineTone(PARKER, RATE), LineTone(PARKER.replace("DL0", "DL40") + " AL0", RATE)
        self.assertEqual(dbfs(seconds(off, 1, "listening")) > -60, True)
        self.assertGreater(dbfs(seconds(on, 3, "listening")), -60)


class PhaseTest(unittest.TestCase):
    def test_the_thinking_texture_fades_in_over_the_fade_in_time_and_out_over_the_fade_out(self):
        tone = LineTone(PARKER, RATE)
        base = dbfs(seconds(tone, 2, "listening"))
        early = dbfs(tone.render(int(RATE * 0.02), "thinking"))
        full = dbfs(seconds(tone, 1.0, "thinking")[RATE // 2:])
        self.assertGreater(full, base + 10)  # the hum is well above the hiss
        self.assertLess(early, full - 6)  # BF2 is 0.2 s: the first 20 ms is still ramping
        after = seconds(tone, 3, "listening")
        self.assertLess(dbfs(after[-RATE:]), base + 1.5)  # BO6 is 0.6 s: gone after 3 s

    def test_the_tone_ducks_under_speech_by_the_ducking_amount_and_recovers(self):
        tone = LineTone("AL20 U37", RATE)
        listening = dbfs(seconds(tone, 3, "listening"))
        speaking = dbfs(seconds(tone, 3, "speaking")[RATE:])
        self.assertAlmostEqual(listening - speaking, -20 * np.log10(1 - 0.37), delta=0.5)
        back = dbfs(seconds(tone, 3, "listening")[RATE:])
        self.assertAlmostEqual(back, listening, delta=0.5)

    def test_the_block_size_does_not_change_the_sound(self):
        a, b = LineTone(PARKER, RATE), LineTone(PARKER, RATE)
        whole = np.concatenate([a.render(RATE, "listening"), a.render(RATE, "thinking"), a.render(RATE, "speaking")])
        pieces = np.concatenate([b.render(2400, p) for p in ("listening",) * 10 + ("thinking",) * 10 + ("speaking",) * 10])
        self.assertLess(float(np.max(np.abs(whole - pieces))), 1e-4)

    def test_same_seed_same_sound_and_all_three_characters_render(self):
        a, b = LineTone(PARKER, RATE, seed=3), LineTone(PARKER, RATE, seed=3)
        self.assertTrue(np.array_equal(seconds(a, 1, "thinking"), seconds(b, 1, "thinking")))
        for character in (0, 1, 2):
            x = seconds(LineTone(PARKER.replace("BC2", f"BC{character}"), RATE), 2, "thinking")
            self.assertTrue(np.isfinite(x).all() and dbfs(x) > -70, character)

    def test_an_unknown_phase_is_refused(self):
        with self.assertRaises(ValueError):
            LineTone(PARKER, RATE).render(100, "dancing")


class SpeedTest(unittest.TestCase):
    def test_a_second_of_sound_takes_far_less_than_a_second_to_make(self):
        import time

        tone = LineTone(PARKER, RATE)
        start = time.monotonic()
        for _ in range(10):
            tone.render(2400, "thinking")
        self.assertLess(time.monotonic() - start, 0.5)


if __name__ == "__main__":
    unittest.main()
