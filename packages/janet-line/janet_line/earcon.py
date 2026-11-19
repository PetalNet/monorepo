"""The hang-up earcon: a short soft descending two-note blip played before Janet closes a line.

The code works like the line tone's: keys and numbers, e.g. "HL40 HP880 HI5 HN150 HG30".
  HL  level, 0 to 100 (the same curve as the line tone: (HL/100)^1.5, peak about half of full scale at 100)
  HP  pitch of the first note, Hz
  HI  how far the second note falls, in semitones
  HN  length of each note, ms (a fast attack, then a decay)
  HG  gap between the notes, ms
Empty means no earcon.
"""

from __future__ import annotations

import math
import re

import numpy as np

DEFAULTS = {"HL": 40, "HP": 880, "HI": 5, "HN": 150, "HG": 30}


def parse_code(code: str) -> dict[str, int]:
    values = dict(DEFAULTS)
    for part in re.split(r"[\s,]+", code.strip()):
        if not part:
            continue
        match = re.fullmatch(r"([A-Z]+)(\d+)", part)
        if not match or match.group(1) not in DEFAULTS:
            raise ValueError(f"not an earcon code: {part!r}")
        values[match.group(1)] = int(match.group(2))
    if not 0 <= values["HL"] <= 100:
        raise ValueError("HL, the level, is 0 to 100")
    if not 100 <= values["HP"] <= 4000:
        raise ValueError("HP, the first pitch in Hz, is 100 to 4000")
    if not 0 <= values["HI"] <= 24:
        raise ValueError("HI, the fall in semitones, is 0 to 24")
    if not 20 <= values["HN"] <= 1000 or not 0 <= values["HG"] <= 500:
        raise ValueError("HN is 20 to 1000 ms and HG 0 to 500 ms")
    return values


def render(code: str, rate: int) -> np.ndarray:
    """The earcon as float samples in -1..1 at `rate`, mono."""
    v = parse_code(code)
    amplitude = (v["HL"] / 100) ** 1.5 * 0.5
    notes = []
    for freq in (v["HP"], v["HP"] * 2 ** (-v["HI"] / 12)):
        n = int(rate * v["HN"] / 1000)
        t = np.arange(n) / rate
        attack = np.minimum(1.0, t / 0.008)  # no click
        decay = np.exp(-t / (v["HN"] / 1000 / 3))  # about 26 dB down by the end of the note
        tone = np.sin(2 * np.pi * freq * t) + 0.15 * np.sin(2 * np.pi * 2 * freq * t)  # a little warmth
        notes.append(tone / 1.15 * attack * decay * amplitude)
        notes.append(np.zeros(int(rate * v["HG"] / 1000)))
    return np.concatenate(notes[:-1]).astype(np.float32)


def duration_s(code: str) -> float:
    v = parse_code(code)
    return (2 * v["HN"] + v["HG"]) / 1000
