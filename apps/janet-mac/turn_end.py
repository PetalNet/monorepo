#!/usr/bin/env python3
"""Decides when a speaker has finished their turn, from the microphone audio.

Silence alone cannot tell a finished thought from a pause in the middle of one, so two local
models share the decision:

- Silero VAD says, 31 times a second, whether the latest audio is speech;
- Smart Turn listens to the turn so far and says whether it sounds finished.

Smart Turn is asked several times while a silence lasts, and has to be less sure each time: a
turn ends early only when it clearly sounds finished, and a long silence ends it whatever it
sounds like. There is no limit on how long the speaker may talk.

As a program it reads mono float32 audio on standard input, prints why it stopped, and exits:
`finished`, `quiet` (a long silence after speech that never sounded finished), `nothing said`,
`key` (the stop file appeared), `limit` or `stream ended`.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RATE = 16000
FRAME = 512  # the only frame Silero takes at 16 kHz
FRAME_S = FRAME / RATE
SMART_TURN_S = 8  # Smart Turn hears the last eight seconds of the turn
LEAD_IN_S = 0.5  # audio kept from before the first speech


def _session(path: Path):
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return onnxruntime.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


class Silero:
    """Silero VAD v6: the chance that one frame is speech."""

    def __init__(self, path: Path):
        self._session = _session(path)
        self._state = np.zeros((2, 1, 128), np.float32)
        self._context = np.zeros(64, np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        heard = np.concatenate([self._context, frame])[None]
        out, self._state = self._session.run(
            None, {"input": heard, "state": self._state, "sr": np.array(RATE, np.int64)}
        )
        self._context = frame[-64:]
        return float(out[0][0])


def _mel_filters() -> np.ndarray:
    """The 80 Slaney mel filters Whisper's feature extractor uses, as (201, 80)."""

    def to_hz(mel: np.ndarray) -> np.ndarray:
        return np.where(mel < 15, 200 * mel / 3, 1000 * np.exp(np.log(6.4) / 27 * (mel - 15)))

    top = 15 + np.log(8000 / 1000) * 27 / np.log(6.4)
    edges = to_hz(np.linspace(0, top, 82))
    slopes = edges[None, :] - np.linspace(0, RATE / 2, 201)[:, None]
    widths = np.diff(edges)
    filters = np.maximum(0, np.minimum(-slopes[:, :-2] / widths[:-1], slopes[:, 2:] / widths[1:]))
    return filters * (2 / (edges[2:] - edges[:-2]))


_MEL_FILTERS = _mel_filters()
_WINDOW = np.hanning(401)[:-1]


def whisper_features(audio: np.ndarray) -> np.ndarray:
    """Whisper's log-mel features of the last eight seconds, silence-padded at the front."""
    size = SMART_TURN_S * RATE
    audio = audio[-size:].astype(np.float64)
    audio = np.concatenate([np.zeros(size - len(audio)), audio])
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(audio, 200, mode="reflect"), 400)[::160]
    power = np.abs(np.fft.rfft(frames * _WINDOW, axis=1)) ** 2
    mel = np.log10(np.maximum(1e-10, power @ _MEL_FILTERS)).T[:, :-1]
    return ((np.maximum(mel, mel.max() - 8) + 4) / 4).astype(np.float32)


class SmartTurn:
    """Smart Turn v3: the chance that the turn so far is finished."""

    def __init__(self, path: Path):
        self._session = _session(path)

    def __call__(self, audio: np.ndarray) -> float:
        return float(self._session.run(None, {"input_features": whisper_features(audio)[None]})[0].reshape(-1)[0])


@dataclass(frozen=True)
class Policy:
    speech: float = 0.5  # Silero chance that counts as speech
    start_s: float = 0.1  # unbroken speech that starts a turn: a click is shorter
    # (seconds of silence, how sure Smart Turn must be that the turn is finished). People stop
    # to think after a finished sentence, so a short silence ends the turn only on near certainty.
    asks: tuple[tuple[float, float], ...] = ((1.0, 0.98), (1.5, 0.98), (2.0, 0.9), (2.5, 0.9), (3.0, 0.5))
    quiet_s: float = 4.0  # silence that ends a turn however unfinished it sounds
    nothing_said_s: float = 6.0


class To16k:
    """Resamples a stream of chunks at any microphone rate to 16 kHz."""

    def __init__(self, rate: int):
        pass_hz = 2 * min(7500.0, 0.47 * rate)
        self._filter = np.sinc(np.arange(-47, 48) * pass_hz / rate) * np.hamming(95) * pass_hz / rate
        self._step = rate / RATE
        self._held = np.zeros(94)
        self._last = np.zeros(1)
        self._next = 1.0  # where the next output falls, counted from the last filtered sample

    def __call__(self, chunk: np.ndarray) -> np.ndarray:
        heard = np.concatenate([self._held, chunk])
        self._held = heard[-94:]
        smooth = np.concatenate([self._last, np.convolve(heard, self._filter, "valid")])
        self._last = smooth[-1:]
        at = np.arange(self._next, len(smooth) - 1 + 1e-9, self._step)
        self._next = (at[-1] + self._step if len(at) else self._next) - (len(smooth) - 1)
        return np.interp(at, np.arange(len(smooth)), smooth).astype(np.float32)


def frames(stream, rate: int):
    """Yields 16 kHz frames from a stream of mono float32 at `rate`, as the audio arrives."""
    to_16k = To16k(rate) if rate != RATE else None
    raw = b""
    audio = np.zeros(0, np.float32)
    while chunk := stream.read1(1 << 16):
        raw += chunk
        whole = len(raw) - len(raw) % 4
        heard, raw = np.frombuffer(raw[:whole], "<f4"), raw[whole:]
        audio = np.concatenate([audio, to_16k(heard) if to_16k else heard])
        while len(audio) >= FRAME:
            yield audio[:FRAME]
            audio = audio[FRAME:]


class TurnEnd:
    """Fed one frame at a time; says why the turn ended, once it has."""

    def __init__(self, vad: Silero, smart_turn: SmartTurn, policy: Policy = Policy()):
        self._vad = vad
        self._smart_turn = smart_turn
        self._policy = policy
        self._turn = np.zeros(0, np.float32)
        self._heard_s = 0.0
        self._speech_run_s = 0.0
        self._started = False
        self._silence_s = 0.0
        self._asks = 0
        self.asked: list[float] = []

    def feed(self, frame: np.ndarray) -> str | None:
        policy = self._policy
        self._heard_s += FRAME_S
        keep = SMART_TURN_S if self._started else LEAD_IN_S
        self._turn = np.concatenate([self._turn, frame])[-int(keep * RATE) :]
        if self._vad(frame) >= policy.speech:
            self._speech_run_s += FRAME_S
            self._started = self._started or self._speech_run_s >= policy.start_s
            self._silence_s = 0.0
            self._asks = 0
            return None
        self._speech_run_s = 0.0
        if not self._started:
            return "nothing said" if self._heard_s >= policy.nothing_said_s else None
        self._silence_s += FRAME_S
        if self._silence_s >= policy.quiet_s:
            return "quiet"
        if self._asks < len(policy.asks) and self._silence_s >= policy.asks[self._asks][0] - 1e-6:
            sure = policy.asks[self._asks][1]
            self._asks += 1
            self.asked.append(self._smart_turn(self._turn))
            if self.asked[-1] > sure:
                return "finished"
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--models", type=Path, required=True, help="directory holding the two ONNX models")
    parser.add_argument("--rate", type=int, default=RATE, help="sample rate of the audio on standard input")
    parser.add_argument("--stop-file", type=Path, help="stop as soon as this file exists")
    parser.add_argument("--max-s", type=float, default=300.0, help="backstop on the whole listen")
    parser.add_argument("--nothing-said-s", type=float, default=Policy.nothing_said_s)
    args = parser.parse_args()

    vad = Silero(args.models / "silero_vad.onnx")
    smart_turn = SmartTurn(args.models / "smart-turn-v3.2-cpu.onnx")
    turn_end = TurnEnd(vad, smart_turn, Policy(nothing_said_s=args.nothing_said_s))
    start = time.monotonic()
    heard_s = 0.0
    why = "stream ended"
    for frame in frames(sys.stdin.buffer, args.rate):
        heard_s += FRAME_S
        if verdict := turn_end.feed(frame):
            why = verdict
        elif args.stop_file and args.stop_file.exists():
            why = "key"
        elif time.monotonic() - start >= args.max_s:
            why = "limit"
        else:
            continue
        break
    asked = " ".join(f"{chance:.2f}" for chance in turn_end.asked)
    print(f"{why} ({heard_s:.1f} s heard, smart turn said {asked or '-'})", flush=True)
    os._exit(0)  # the audio stream on standard input may never end


if __name__ == "__main__":
    main()
