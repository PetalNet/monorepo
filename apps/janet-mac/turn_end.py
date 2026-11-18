#!/usr/bin/env python3
"""Decides when a speaker has finished their turn, from the microphone audio.

Silero VAD says, 31 times a second, whether the latest audio is speech. The turn ends when no
speech has been heard for a while. There is no limit on how long the speaker may talk.

With turn_judge.py and its speech model installed, a pause is also judged the way a listener
would: after a second of silence the turn ends at once when the speaker sounds done, and after
an "um" the wait is much longer. Without them every pause waits the full `quiet_s`.

As a program it reads mono float32 audio on standard input, prints why it stopped, and exits:
`done` (judged finished), `quiet` (the speaker stopped), `nothing said`, `key` (the stop file
appeared), `limit` or `stream ended`.

With `--claim DIR` it listens on while a reply is being made: when speech begins it makes DIR
and marks it `resumed`, then hears the speaker out as usual. If DIR is already there, the reply
has begun to play and it stops with `key`.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RATE = 16000
FRAME = 512  # the only frame Silero takes at 16 kHz
FRAME_S = FRAME / RATE
RESUME_S = 0.3  # unbroken speech that takes the turn back while a reply is being made


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


@dataclass(frozen=True)
class Policy:
    speech: float = 0.5  # Silero chance that counts as speech
    start_s: float = 0.1  # unbroken speech that starts a turn: a click is shorter
    # Silence that ends a turn. People stop to think in the middle of one, often for a second or
    # two, so anything shorter cuts them off.
    quiet_s: float = 3.0
    nothing_said_s: float = 6.0
    # With a judge: the silences at which it is asked whether the speaker is done, and the
    # silence that ends a turn after a filled pause ("um"), which promises more.
    judge_at_s: tuple[float, ...] = (1.0, 1.5, 2.0, 2.5)
    hold_s: float = 6.0


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
        if not whole:
            continue
        heard, raw = np.frombuffer(raw[:whole], "<f4"), raw[whole:]
        audio = np.concatenate([audio, to_16k(heard) if to_16k else heard])
        while len(audio) >= FRAME:
            yield audio[:FRAME]
            audio = audio[FRAME:]


class TurnEnd:
    """Fed one frame at a time; says why the turn ended, once it has."""

    def __init__(self, vad: Silero, policy: Policy = Policy(), hearing=None, on_start=None):
        self._vad = vad
        self._policy = policy
        self._on_start = on_start  # called once, when the speaker begins
        self._hearing = hearing  # a turn_judge.Hearing, or None to go by silence alone
        self._judge_at = {round(s / FRAME_S) for s in policy.judge_at_s}
        self._silent = 0
        self._hold = False
        self._heard_s = 0.0
        self._speech_run_s = 0.0
        self._started = False
        self._silence_s = 0.0

    def _judged(self, ask):
        """Asks the judge, if there is one. A judge that fails is dropped: the turn then ends on
        silence alone, as it would without one."""
        if self._hearing is None:
            return None
        try:
            return ask(self._hearing)
        except Exception as error:
            print(f"turn judge dropped: {error!r}", file=sys.stderr)
            self._hearing = None
            return None

    def feed(self, frame: np.ndarray) -> str | None:
        policy = self._policy
        self._heard_s += FRAME_S
        said = self._vad(frame) >= policy.speech
        self._speech_run_s = self._speech_run_s + FRAME_S if said else 0.0
        self._judged(lambda hearing: hearing.hear(frame, said))
        # Once a turn has started, one frame of speech is enough to keep it open. Asking for more
        # cut speakers off more often on recorded turns, and no recording was held open by noise.
        if self._speech_run_s >= (FRAME_S if self._started else policy.start_s):
            if not self._started and self._on_start:
                self._on_start()
            self._started = True
            self._silence_s = 0.0
            self._silent = 0
            self._hold = False
            return None
        if not self._started:
            return "nothing said" if self._heard_s >= policy.nothing_said_s else None
        self._silence_s += FRAME_S
        self._silent += 1
        if self._silent in self._judge_at:
            verdict = self._judged(lambda hearing: hearing.verdict(self._silent))
            self._hold = self._hold or verdict == "hold"
            if verdict == "done" and not self._hold:
                return "done"
        return "quiet" if self._silence_s >= (policy.hold_s if self._hold else policy.quiet_s) else None


def took_the_turn(claim: Path) -> bool:
    """While a reply is being made, whoever makes this directory first has the turn: the speaker
    by going on talking (this marks it `resumed`), or the reply by starting to play."""
    try:
        claim.mkdir()
    except FileExistsError:
        return False
    (claim / "resumed").touch()
    return True


def hearing(models: Path):
    """The judge, when turn_judge.py, its fitted model and its speech model are all installed."""
    fitted = Path(__file__).with_name("turn_judge.json")
    needed = [fitted, models / "parakeet_realtime_eou_120m.int8.onnx", models / "parakeet_vocab.txt"]
    try:
        from turn_judge import Hearing

        if all(path.exists() for path in needed):
            return Hearing(models, fitted)
    except Exception as error:  # the judge is an extra: without it the turn ends on silence, as before
        print(f"no turn judge: {error}", file=sys.stderr)
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--models", type=Path, required=True, help="directory holding silero_vad.onnx")
    parser.add_argument("--rate", type=int, default=RATE, help="sample rate of the audio on standard input")
    parser.add_argument("--stop-file", type=Path, action="append", default=[], help="stop as soon as this file exists")
    parser.add_argument("--max-s", type=float, default=300.0, help="backstop on the whole listen")
    parser.add_argument("--nothing-said-s", type=float, default=Policy.nothing_said_s)
    parser.add_argument("--claim", type=Path, help="a directory to make when speech begins; when it is there already, stop")
    args = parser.parse_args()

    start = time.monotonic()  # before the model loads: the limit is on the whole listen
    heard_s = 0.0
    once = threading.Lock()

    def stop(why: str) -> None:
        if once.acquire(blocking=False):
            print(f"{why} ({heard_s:.1f} s heard)", flush=True)
            os._exit(0)  # the audio stream on standard input may never end

    def watch() -> None:
        # Its own thread, so a stalled audio stream cannot hold up the key or the limit.
        while True:
            if any(path.exists() for path in args.stop_file):
                stop("key")
            if time.monotonic() - start >= args.max_s:
                stop("limit")
            time.sleep(0.05)

    def claim() -> None:
        if not took_the_turn(args.claim):
            stop("key")

    # Going on talking takes more to believe than starting to: a reply is dropped for it.
    policy = Policy(nothing_said_s=args.nothing_said_s, start_s=RESUME_S if args.claim else Policy.start_s)
    turn_end = TurnEnd(Silero(args.models / "silero_vad.onnx"), policy, hearing(args.models), claim if args.claim else None)
    threading.Thread(target=watch, daemon=True).start()
    for frame in frames(sys.stdin.buffer, args.rate):
        heard_s += FRAME_S
        if why := turn_end.feed(frame):
            stop(why)
    stop("stream ended")


if __name__ == "__main__":
    main()
