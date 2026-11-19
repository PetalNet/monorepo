"""Validate the private manifests before training or scoring any clips."""

import argparse
from collections import Counter
import json
import math
from pathlib import Path, PureWindowsPath
import wave


def read_rows(path: Path) -> dict[str, dict]:
    rows = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError(f"{path.name}:{number}: expected a nonempty string id")
        if row["id"] in rows:
            raise ValueError(f"{path.name}:{number}: duplicate id")
        rows[row["id"]] = row
    if not rows:
        raise ValueError(f"{path.name}: empty manifest")
    return rows


def load_dataset(clips: Path, labels: Path, audio_root: Path | None = None) -> list[dict]:
    clip_rows, label_rows = read_rows(clips), read_rows(labels)
    if clip_rows.keys() != label_rows.keys():
        raise ValueError(
            f"label coverage mismatch: {len(clip_rows.keys() - label_rows.keys())} missing, "
            f"{len(label_rows.keys() - clip_rows.keys())} orphan labels"
        )
    recordings, paths, result = {}, set(), []
    for row in clip_rows.values():
        part, recording = row.get("split"), row.get("recording")
        if part not in {"train", "val", "test"}:
            raise ValueError("unknown split")
        if not isinstance(recording, str) or not recording:
            raise ValueError("missing recording identity")
        if recordings.setdefault(recording, part) != part:
            raise ValueError("recording occurs in more than one split")
        text = label_rows[row["id"]].get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("empty or non-string transcript")
        source = row.get("wav")
        if not isinstance(source, str) or not source:
            raise ValueError("missing wav path")
        wav = (audio_root / part / PureWindowsPath(source).name) if audio_root else Path(source)
        wav = wav.resolve(strict=True)
        if wav in paths:
            raise ValueError("multiple ids refer to the same wav")
        paths.add(wav)
        with wave.open(str(wav), "rb") as audio:
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getcomptype()) != (
                16000, 1, 2, "NONE"
            ):
                raise ValueError("expected uncompressed 16 kHz mono PCM16 WAV")
            frames = audio.getnframes()
            if len(audio.readframes(frames)) != frames * 2:
                raise ValueError("truncated WAV data")
        seconds = frames / 16000
        declared = row.get("seconds")
        if not isinstance(declared, (int, float)) or not math.isfinite(declared):
            raise ValueError("invalid declared duration")
        if seconds < 0.5 or seconds > 30 or abs(seconds - declared) > 1 / 16000:
            raise ValueError("duration mismatch or clip outside 0.5–30 seconds")
        result.append({**row, "wav": wav, "seconds": seconds, "text": text})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clips", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--audio-root", type=Path)
    args = parser.parse_args()
    rows = load_dataset(args.clips, args.labels, args.audio_root)
    print(json.dumps({
        "clips": len(rows),
        "recordings": len({row["recording"] for row in rows}),
        "splits": dict(Counter(row["split"] for row in rows)),
        "seconds": {part: sum(row["seconds"] for row in rows if row["split"] == part)
                    for part in ("train", "val", "test")},
    }, indent=2))


if __name__ == "__main__":
    main()
