"""Judges, at a pause, whether the speaker has finished or is only thinking.

It hears what a person listening would: the words so far (a small speech model that writes them
down as they are said, on this machine), the pace, and how the turn has gone. A few numbers
describe the pause, and a logistic model fitted on recorded turns of the person who uses this
Mac turns them into the chance that he is done. Pitch and loudness were measured on those turns
too and told a finished thought from a pause to think no better than chance, so they are not
here.

A filled pause ("um", "uh") or a trailing "so" or "and" is not judged: it always means more
is coming.
"""

from __future__ import annotations

import json
import math
import queue
import sys
import threading
from pathlib import Path

import numpy as np

RATE = 16000
FRAME = 512
FRAME_S = FRAME / RATE
CHUNK = 2560  # the speech model takes 160 ms at a time: five frames
PAUSE_S = 0.5  # a gap this long splits what was said into clauses

FILLERS = {"um", "uh", "uhh", "uhm", "umm", "hmm", "hm", "mm", "er", "erm", "ah"}
# Words that lead somewhere: a turn does not end on one.
LEADING = {
    "and", "so", "but", "or", "because", "like", "the", "a", "an", "to", "of", "if", "with", "for", "in", "at", "then",
    "which", "when", "where", "as", "from", "my", "your", "their", "our", "i", "we", "i'm", "it's", "also", "just",
    "really", "very", "by", "into", "about", "than", "would", "could", "should", "can", "will", "actually", "basically",
    "maybe", "need", "that's", "there's", "they", "he", "she", "is", "are", "was", "have", "has",
}  # fmt: skip
# Words that hand the turn over.
CLOSING = {"please", "thanks", "you", "know", "yeah", "understand", "sense", "think", "luck", "fun", "bye"}
ASKING = {
    "what", "what's", "how", "how's", "why", "where", "where's", "when", "who", "who's", "which", "can", "could",
    "do", "does", "did", "is", "are", "should", "will", "would", "have", "has", "please",
}  # fmt: skip
SHORT_S = 15.0
UNWORDED_S = 0.4  # voiced sound this long with no word in it is a filled pause


class Words:
    """The streaming speech model: 160 ms of audio in, the words it now knows out."""

    BLANK, END = 1026, (1024, 1025)

    def __init__(self, model: Path, vocab: Path):
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self._session = onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        self._vocab = vocab.read_text(encoding="utf-8").split("\n")
        self._outputs = [o.name for o in self._session.get_outputs()]
        self._state = {
            "audio_cache": np.zeros([160], np.float32),
            "mel_cache": np.full([1, 128, 9], math.log(2.0**-24), np.float32),
            "cache_last_channel": np.zeros([1, 17, 70, 512], np.float32),
            "cache_last_time": np.zeros([1, 17, 512, 8], np.float32),
            "cache_last_channel_len": np.zeros([1], np.int64),
            "pred_h": np.zeros([1, 640], np.float32),
            "pred_c": np.zeros([1, 640], np.float32),
            "last_token": np.array([self.BLANK], np.int64),
        }
        self._chunks = 0

    def __call__(self, chunk: np.ndarray) -> tuple[list[tuple[str, float]], bool]:
        """Returns the word pieces heard in this chunk with their times, and whether the model
        itself marked an end of utterance."""
        out = dict(zip(self._outputs, self._session.run(None, {**self._state, "audio": chunk.astype(np.float32)})))
        self._state = {name: out[name + "_out"] for name in self._state}
        count = int(out["num_tokens"][0])
        base = self._chunks * 2
        self._chunks += 1
        tokens = [(int(t), (base + int(f)) * 0.08) for t, f in zip(out["tokens"][:count], out["token_frames"][:count])]
        pieces = [(self._vocab[t], at) for t, at in tokens if t not in self.END]
        return pieces, any(t in self.END for t, _ in tokens)


def words_of(pieces: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Word pieces joined into words, each with the time it began."""
    words: list[tuple[str, float]] = []
    for piece, at in pieces:
        if piece.startswith("▁") or not words:
            words.append((piece.lstrip("▁"), at))
        else:
            words[-1] = (words[-1][0] + piece, words[-1][1])
    return [(word, at) for word, at in words if word]


def cues(speech: list[bool], pieces: list[tuple[str, float]], ended: bool, pause: int) -> dict[str, float]:
    """What is known about a pause that began at frame `pause`, from what was heard up to now.

    `speech` holds one value per frame; `pieces` are the word pieces the speech model has given
    so far; `ended` says it marked an end of utterance during this pause.
    """
    start = next((i for i, said in enumerate(speech) if said), 0)
    words = [(w, at) for w, at in words_of(pieces) if at <= pause * FRAME_S + 0.3]
    last = words[-1][0] if words else ""
    clause = len(words)
    for i in range(len(words) - 1, 0, -1):
        if words[i][1] - words[i - 1][1] >= PAUSE_S + 0.4:  # word starts this far apart had a pause between
            clause = len(words) - i
            break
    opening = [w for w, _ in words[len(words) - clause :][:2]]
    recent = [at for _, at in words if at >= pause * FRAME_S - 3.0]
    # Speech the model wrote no word for, between the last word and the pause: an "um" sounds
    # like this. With no word heard at all there is nothing to measure it against.
    unworded = sum(speech[round((words[-1][1] + 0.45) / FRAME_S) : pause]) if words else 0
    gaps, run = [], 0
    for said in speech[start:pause]:
        if said:
            if run * FRAME_S >= PAUSE_S:
                gaps.append(run * FRAME_S)
            run = 0
        else:
            run += 1
    c = {
        "turn_s": (pause - start) * FRAME_S,
        "leading": float(last in LEADING),
        "filler": float(last in FILLERS),
        "closing": float(last in CLOSING),
        "unworded_s": unworded * FRAME_S,
        "asking": float(any(w in ASKING for w in opening)),
        "model_end": float(ended),
        "pace": len(recent) / 3.0,
        "long_pauses": float(sum(g >= 1.0 for g in gaps)),
        "longest_pause_s": max(gaps, default=0.0),
    }
    # A short turn that asks something or hands over is a question to answer, not a pause to think.
    short = float(c["turn_s"] < SHORT_S and c["long_pauses"] == 0)
    c.update(short=short, short_asking=short * c["asking"], short_closing=short * c["closing"], short_end=short * c["model_end"])
    return c


def filled(c: dict[str, float]) -> bool:
    """More is coming: an "um" (the speech model writes most of them down as nothing at all, so
    voice with no word to it counts), or a last word that leads somewhere ("and", "so", "the")."""
    return bool(c["filler"]) or c["unworded_s"] >= UNWORDED_S or bool(c["leading"])


class Judge:
    """The fitted model: the chance that the speaker is done, from a pause's cues."""

    def __init__(self, path: Path):
        fitted = json.loads(path.read_text())
        self.names: list[str] = fitted["cues"]
        self._mean = np.array(fitted["mean"])
        self._scale = np.array(fitted["scale"])
        self._weight = np.array(fitted["weight"])
        self._bias: float = fitted["bias"]
        self.sure: float = fitted["sure"]  # the chance at which the turn ends early

    def done(self, c: dict[str, float]) -> float:
        x = (np.array([c[name] for name in self.names]) - self._mean) / self._scale
        return float(1 / (1 + np.exp(-(x @ self._weight + self._bias))))


class Hearing:
    """Keeps what the judge needs as the audio arrives. The speech model runs on a thread of its
    own, so listening never waits for it."""

    def __init__(self, models: Path, fitted: Path):
        self._judge = Judge(fitted)
        self._speech: list[bool] = []
        self._pieces: list[tuple[str, float]] = []
        self._ends: list[float] = []  # when the speech model marked an end of utterance
        self._transcribed_s = 0.0
        self._frames: queue.Queue[np.ndarray] | None = queue.Queue()
        threading.Thread(target=self._transcribe, args=(models,), daemon=True).start()

    def hear(self, frame: np.ndarray, said: bool) -> None:
        self._speech.append(said)
        frames = self._frames  # the other thread drops it when the speech model fails
        if frames is not None:
            frames.put(frame)

    def _transcribe(self, models: Path) -> None:
        frames = self._frames
        try:
            words = Words(models / "parakeet_realtime_eou_120m.int8.onnx", models / "parakeet_vocab.txt")
            held: list[np.ndarray] = []
            while True:
                held.append(frames.get())
                if len(held) * FRAME == CHUNK:
                    pieces, ended = words(np.concatenate(held))
                    held = []
                    self._pieces.extend(pieces)
                    self._transcribed_s += CHUNK / RATE
                    if ended:
                        self._ends.append(self._transcribed_s)
        except Exception as error:  # no speech model, no calls: the turn then ends on silence alone
            print(f"no turn judge: {error}", file=sys.stderr)
            self._frames = None

    def verdict(self, silent: int) -> str | None:
        """After `silent` frames of silence: "done", "hold" when more is coming, or None for no
        call. No call is also the answer while the speech model is behind or has not loaded."""
        now = len(self._speech)
        if now * FRAME_S - self._transcribed_s > 0.5:
            return None
        pause = now - silent
        ended = any(end > pause * FRAME_S - 0.3 for end in self._ends)
        c = cues(self._speech, list(self._pieces), ended, pause)
        if filled(c):
            return "hold"
        return "done" if self._judge.done(c) >= self._judge.sure else None
