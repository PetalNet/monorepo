"""The call line tone, ported from Parker's tuning page (a Web Audio graph) to numpy so every voice surface mixes the same sound.

Layers, as on the page:
  A  comfort noise: pink noise, high-passed at 180 Hz and low-passed by the tone control, mono and stereo crossfaded by width.
  B  thinking texture: one of three characters (shimmer, pulse, low hum) behind a fade envelope; it is heard only while a reply is
     being worked on.
  D  room tone: low-passed brown noise with slow modulation and a faint drone.
Phases come from the pipeline: "listening" (A and D), "thinking" (B fades in), "speaking" (every layer ducks under the voice).

Differences from the page, none audible at these levels: pink noise is shaped in the frequency domain, not by Paul Kellet's filter;
the room tone's low-pass is fixed, not swept; the master compressor (threshold -24 dB) is left out because the tone sits far below it.

The code is the page's "Your code": keys and 0 to 100 values, e.g. "AL6 AT45 AW83 BC2 BL11 BR7 BF2 BO6 DL0 DW48 U37 V80".
"""

from __future__ import annotations

import math
import re

import numpy as np

DEFAULTS = {"AL": 8, "AT": 45, "AW": 50, "BC": 0, "BL": 20, "BR": 50, "BF": 8, "BO": 12, "DL": 0, "DW": 50, "U": 55, "V": 80}
PHASES = ("listening", "thinking", "speaking")


def parse_code(code: str) -> dict[str, int]:
    """A code such as "AL6 AT45 ...": unknown keys are an error, missing ones take the page's defaults."""
    values = dict(DEFAULTS)
    for part in re.split(r"[\s,]+", code.strip()):
        if not part:
            continue
        match = re.fullmatch(r"([A-Z]+)(\d+)", part)
        if not match or match.group(1) not in DEFAULTS:
            raise ValueError(f"not a line tone code: {part!r}")
        values[match.group(1)] = int(match.group(2))
    if values["BC"] not in (0, 1, 2):
        raise ValueError("BC is 0, 1 or 2")
    return values


def _level(x: float) -> float:
    return (x / 100) ** 1.5


class Biquad:
    """A Web Audio biquad. Low and high pass take Q in decibels, band pass in linear units, as the browser does."""

    def __init__(self, kind: str, freq: float, rate: int, q: float = 1.0):
        w = 2 * math.pi * min(freq, rate / 2 - 1) / rate
        cos, sin = math.cos(w), math.sin(w)
        if kind == "bandpass":
            alpha = sin / (2 * q)
            b = [alpha, 0.0, -alpha]
        else:
            alpha = sin / (2 * 10 ** (q / 20))
            b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] if kind == "lowpass" else [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
        a0 = 1 + alpha
        self.b = [x / a0 for x in b]
        self.a = [1.0, -2 * cos / a0, (1 - alpha) / a0]
        self._z = [0.0, 0.0]

    def response(self, n: int) -> np.ndarray:
        """The frequency response at the n // 2 + 1 points of an n-point FFT."""
        z = np.exp(-1j * 2 * np.pi * np.arange(n // 2 + 1) / n)
        return (self.b[0] + self.b[1] * z + self.b[2] * z**2) / (self.a[0] + self.a[1] * z + self.a[2] * z**2)

    def __call__(self, x: np.ndarray) -> np.ndarray:
        """Filters a block, keeping state between blocks."""
        b0, b1, b2 = self.b
        a1, a2 = self.a[1], self.a[2]
        z1, z2 = self._z
        out = np.empty(len(x))
        for i, v in enumerate(x.tolist()):
            y = b0 * v + z1
            z1 = b1 * v - a1 * y + z2
            z2 = b2 * v - a2 * y
            out[i] = y
        self._z = [z1, z2]
        return out


def _normalize(x: np.ndarray, rms: float = 0.2) -> np.ndarray:
    return x * (rms / math.sqrt(float(np.mean(x * x))))


def _through(x: np.ndarray, filters: tuple[Biquad, ...]) -> np.ndarray:
    """A periodic loop through filters, by multiplying its spectrum: the steady state, with no seam."""
    spectrum = np.fft.rfft(x)
    for f in filters:
        spectrum = spectrum * f.response(len(x))
    return np.fft.irfft(spectrum, len(x))


def _noise(kind: str, rng: np.random.Generator, n: int, rate: int) -> np.ndarray:
    """One periodic noise loop of n samples at rms 0.2, as the page makes it: normalized before any filter."""
    spectrum = np.fft.rfft(rng.uniform(-1, 1, n))
    freq = np.maximum(np.fft.rfftfreq(n, 1 / rate), rate / n)
    if kind == "pink":
        spectrum = spectrum / np.sqrt(freq)
    else:  # brown: the page's leaky integrator, l = (l + .02 w) / 1.02
        z = np.exp(-1j * 2 * np.pi * np.arange(n // 2 + 1) / n)
        spectrum = spectrum * (0.02 / 1.02) / (1 - z / 1.02)
    return _normalize(np.fft.irfft(spectrum, n))


class LineTone:
    """Renders the line tone a block at a time for a stream at `rate`.

    render(frames, phase) returns a (frames, 2) float32 array in -1..1. A mono surface takes channel 0.
    """

    LOOP_S = 6

    def __init__(self, code: str = "", rate: int = 24000, seed: int = 1):
        self.v = parse_code(code)
        self.rate = rate
        v, rng, n = self.v, np.random.default_rng(seed), rate * self.LOOP_S
        self._t = 0  # samples rendered
        # A: pink, stereo and mono loops, high-passed at 180 Hz then low-passed by the tone control.
        lp = Biquad("lowpass", 300 * 20 ** (v["AT"] / 100), rate, 0.7)
        hp = Biquad("highpass", 180, rate)
        stereo = np.stack([_through(_noise("pink", rng, n, rate), (hp, lp)) for _ in range(2)])
        mono = _through(_noise("pink", rng, n, rate), (hp, lp))
        width = v["AW"] / 100
        self._a = ((1 - width) * mono[None, :] + width * stereo) * _level(v["AL"]) * 2
        self._a_pos = 0
        # B: the chosen character, each rendered from oscillators; filters keep state across blocks.
        r = v["BR"] / 100
        self._b_char, self._b_rate = v["BC"], r
        self._b_filters = {
            0: (Biquad("highpass", 2500, rate), Biquad("bandpass", 5200, rate, 1.2)),
            1: (Biquad("lowpass", 700, rate),),
            2: (Biquad("lowpass", 500, rate),),
        }[v["BC"]]
        self._shimmer = _noise("pink", rng, rate * 5, rate)  # stereo on the page; one channel here
        self._b_level = _level(v["BL"]) * 0.8
        self._env = 0.0
        # D: low-passed brown noise with slow modulation and a faint drone.
        warmth = v["DW"] / 100
        dlp = Biquad("lowpass", 1400 - 1100 * warmth, rate, 0.5)
        self._d = np.stack([_through(_noise("brown", rng, rate * 8, rate), (dlp,)) for _ in range(2)])
        self._d_pos, self._d_level, self._d_drone = 0, _level(v["DL"]) * 0.6, 0.05 + 0.5 * warmth
        self._d_mod, self._d_target = 0.8, 0.8
        self._rng = rng
        # ducking under speech
        self._duck = 1.0

    # --- helpers ---------------------------------------------------------------------------------------------------
    def _loop(self, buf: np.ndarray, pos: int, frames: int) -> tuple[np.ndarray, int]:
        n = buf.shape[-1]
        idx = (pos + np.arange(frames)) % n
        return buf[..., idx], (pos + frames) % n

    def _osc(self, freq: float, t: np.ndarray, kind: str = "sine") -> np.ndarray:
        ph = (freq * t) % 1.0
        if kind == "triangle":
            return 1 - 4 * np.abs(((ph + 0.25) % 1.0) - 0.5)  # Web Audio's triangle: starts at 0 like the sine, peak 1
        return np.sin(2 * np.pi * ph)

    def _thinking(self, t: np.ndarray) -> np.ndarray:
        r, c = self._b_rate, self._b_char
        if c == 0:  # shimmer: band-passed noise, amplitude-modulated, over a few faint glass partials
            frames = len(t)
            start = int(round(t[0] * self.rate)) % len(self._shimmer)
            noise, _ = self._loop(self._shimmer, start, frames)
            hp, bp = self._b_filters
            am = 0.5 + 0.35 * self._osc(0.3 + r * 2.5, t) + 0.2 * self._osc(0.5 + r * 3.7, t)
            out = bp(hp(noise)) * am * 0.7
            for i, f in enumerate((3136, 4186, 5588)):
                out += 0.012 * self._osc(f, t) * (1 + 0.012 * self._osc((0.4 + i * 0.23) * (0.4 + r * 2), t))
            return out
        if c == 1:  # pulse: two low sines under a slow pulse
            mix = 0.5 * (self._osc(196, t) + self._osc(294, t))
            pulse = 0.5 + 0.5 * self._osc(0.35 + r * 2.65, t)
            return self._b_filters[0](mix) * pulse
        # low hum: two close sines and a quiet triangle, swelling slowly
        swell = 0.8 + 0.2 * self._osc(0.15 + r * 1.6, t)
        raw = (self._osc(110, t) + self._osc(110.7, t) + 0.25 * self._osc(165, t, "triangle")) * swell
        return self._b_filters[0](raw)

    # --- rendering -------------------------------------------------------------------------------------------------
    def render(self, frames: int, phase: str = "listening") -> np.ndarray:
        if phase not in PHASES:
            raise ValueError(f"phase is one of {PHASES}")
        v, rate = self.v, self.rate
        t = (self._t + np.arange(frames)) / rate
        dt = 1 / rate
        # envelopes, per sample: B fades linearly toward 1 (thinking) or 0, the duck follows 1 - U under speech with tau .12 s
        target = 1.0 if phase == "thinking" else 0.0
        seconds = max(0.02, (v["BF"] if target else v["BO"]) / 10)
        env = self._env + np.sign(target - self._env) * np.minimum(abs(target - self._env), dt / seconds * (np.arange(frames) + 1))
        self._env = float(env[-1])
        duck_target = 1 - v["U"] / 100 if phase == "speaking" else 1.0
        k = 1 - math.exp(-dt / 0.12)
        decay = (1 - k) ** (np.arange(frames) + 1)
        duck = duck_target + (self._duck - duck_target) * decay
        self._duck = float(duck[-1])
        a, self._a_pos = self._loop(self._a, self._a_pos, frames)
        out = a.copy()
        if self._env > 0 or env.max() > 0:
            out += self._thinking(t)[None, :] * (env * self._b_level)[None, :]
        if self._d_level > 0:
            d, self._d_pos = self._loop(self._d, self._d_pos, frames)
            drone = sum(g * np.sin(2 * np.pi * f * t) for f, g in ((55, 1), (82.4, 0.5), (110.4, 0.5))) * self._d_drone
            if self._t // (rate * 2) != (self._t + frames) // (rate * 2):
                self._d_target = 0.65 + float(self._rng.random()) * 0.3
            self._d_mod += (self._d_target - self._d_mod) * (1 - math.exp(-frames * dt / 1.3))
            slow = 0.12 * np.sin(2 * np.pi * 0.05 * t) + 0.09 * np.sin(2 * np.pi * 0.11 * t) + 0.06 * np.sin(2 * np.pi * 0.23 * t)
            out += (d + drone[None, :]) * (self._d_mod + slow)[None, :] * self._d_level
        self._t += frames
        return (out * duck[None, :] * (v["V"] / 100)).T.astype(np.float32)


def dbfs(x: np.ndarray) -> float:
    return 20 * math.log10(max(float(np.sqrt(np.mean(np.square(x)))), 1e-12))
