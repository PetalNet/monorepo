import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from janet_line.earcon import duration_s, parse_code, render  # noqa: E402

RATE = 24000
CODE = "HL40 HP880 HI5 HN150 HG30"


def peak_freq(x: np.ndarray) -> float:
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    return float(np.fft.rfftfreq(len(x), 1 / RATE)[int(np.argmax(spectrum))])


class EarconTest(unittest.TestCase):
    def test_two_notes_the_second_a_fourth_below_the_first(self):
        x = render(CODE, RATE)
        n, gap = int(RATE * 0.150), int(RATE * 0.030)
        self.assertEqual(len(x), 2 * n + gap)
        first, second = peak_freq(x[:n]), peak_freq(x[n + gap :])
        self.assertAlmostEqual(first, 880, delta=15)
        self.assertAlmostEqual(second, 880 * 2 ** (-5 / 12), delta=15)

    def test_it_is_soft_clean_and_short(self):
        x = render(CODE, RATE)
        self.assertLess(float(np.abs(x).max()), 0.2)  # peak under -14 dBFS
        self.assertGreater(float(np.abs(x).max()), 0.05)  # but audible
        self.assertAlmostEqual(float(x[0]), 0.0, places=2)  # starts at zero: no click
        self.assertLess(float(np.abs(x[-200:]).max()), 0.01)  # and has died away
        self.assertAlmostEqual(duration_s(CODE), 0.33, places=2)

    def test_the_level_and_the_notes_follow_the_code(self):
        quiet, loud = render("HL20", RATE), render("HL80", RATE)
        self.assertAlmostEqual(20 * math.log10(float(np.abs(loud).max() / np.abs(quiet).max())), 20 * math.log10(4**1.5), delta=0.5)
        self.assertAlmostEqual(peak_freq(render("HP440 HN200", RATE)[: int(RATE * 0.2)]), 440, delta=10)

    def test_a_bad_code_is_refused(self):
        for code in ("ZZ1", "HP50", "HI40", "HN5", "HL", "HL400"):
            with self.assertRaises(ValueError, msg=code):
                parse_code(code)


if __name__ == "__main__":
    unittest.main()
