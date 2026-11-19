"""Cut one speaker's recordings into training and held-out clips for a dictation model.

Whole recordings go to one split, newest first into the held-out set. Clips are cut at the
quietest point in a window; this reduces mid-word cuts but does not guarantee word boundaries.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import scipy.signal as sig
import soundfile as sf

RATE = 16000


def load(path: Path) -> np.ndarray:
    audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    return sig.resample_poly(audio, RATE, rate).astype("float32") if rate != RATE else audio


def pieces(audio: np.ndarray, longest: float, shortest: float) -> list[tuple[int, int]]:
    """Sample ranges no longer than `longest` seconds, each cut where a 25 ms window is quietest."""
    if not 0 < shortest < longest <= 30:
        raise ValueError("clip lengths must satisfy 0 < shortest < longest <= 30")
    if not len(audio):
        return []
    energy = np.sqrt(np.convolve(audio**2, np.ones(400) / 400, "same"))
    start, out = 0, []
    while len(audio) - start > longest * RATE:
        low, high = start + int(shortest * RATE), start + int(longest * RATE)
        cut = low + int(np.argmin(energy[low:high]))
        out.append((start, cut))
        start = cut
    out.append((start, len(audio)))
    return out


def split(seconds: dict[str, float], newest_first: list[str], test_minutes: float, val_minutes: float) -> dict[str, str]:
    """Newest recordings fill the held-out set, the next newest the validation set, the rest train."""
    out, test, val = {}, 0.0, 0.0
    for name in newest_first:
        if test < test_minutes * 60:
            out[name], test = "test", test + seconds[name]
        elif val < val_minutes * 60:
            out[name], val = "val", val + seconds[name]
        else:
            out[name] = "train"
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recordings", type=Path, required=True, help="directory of audio files, one per recording")
    parser.add_argument("--dates", type=Path, required=True, help="TSV: ISO time, file stem; sets the newest-first order")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--test-minutes", type=float, default=11)
    parser.add_argument("--val-minutes", type=float, default=4)
    args = parser.parse_args()
    if args.test_minutes <= 0 or args.val_minutes <= 0:
        parser.error("held-out durations must be positive")

    dated = sorted((line.split("\t")[:2] for line in args.dates.read_text().splitlines() if line.strip()), reverse=True)
    names = [stem for _, stem in dated]
    if len(set(names)) != len(names):
        raise ValueError("duplicate recording in dates manifest")
    audio = {}
    for name in names:
        matches = list(args.recordings.glob(name + ".*"))
        if len(matches) != 1:
            raise ValueError("each dated recording must have exactly one audio file")
        audio[name] = load(matches[0])
    where = split({n: len(audio[n]) / RATE for n in names}, names, args.test_minutes, args.val_minutes)
    if set(where.values()) != {"train", "val", "test"}:
        raise ValueError("not enough recordings to fill all three splits")

    rows = []
    for name in names:
        # Held-out clips are cut one way. Training clips are cut twice, long and short, because
        # dictation ranges from a few words to a paragraph and the encoder sees a different window for each.
        cuts = {"long": (25.0, 15.0)} if where[name] != "train" else {"long": (25.0, 15.0), "short": (10.0, 4.0)}
        for kind, (longest, shortest) in cuts.items():
            for index, (a, b) in enumerate(pieces(audio[name], longest, shortest)):
                if b - a < 0.5 * RATE:
                    continue
                wav = args.out / "clips" / where[name] / f"{name}.{kind}{index:02d}.wav"
                wav.parent.mkdir(parents=True, exist_ok=True)
                sf.write(str(wav), audio[name][a:b], RATE, subtype="PCM_16")
                rows.append({"id": wav.stem, "recording": name, "split": where[name], "wav": str(wav), "seconds": (b - a) / RATE})
    (args.out / "clips.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    for part in ("train", "val", "test"):
        mine = [r for r in rows if r["split"] == part]
        print(part, len({r["recording"] for r in mine}), "recordings", len(mine), "clips", round(sum(r["seconds"] for r in mine) / 60, 1), "min")


if __name__ == "__main__":
    main()
