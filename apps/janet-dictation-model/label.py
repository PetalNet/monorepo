"""Transcribe every clip with the voice system's own speech-to-text server (Wyoming).

The labels a small model is trained on come from the large model the lab already runs, so nothing
leaves the lab. They are machine transcripts: nobody has checked them by ear.
"""

import argparse
import json
import sys
from pathlib import Path

import soundfile as sf

from data import read_rows

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "janet-voice-note"))
from janet_voice_note import address, describe, transcribe


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clips", type=Path, required=True, help="clips.jsonl from cut.py")
    parser.add_argument("--stt", required=True, help="host:port of the Wyoming speech-to-text server")
    parser.add_argument("--out", type=Path, required=True, help="JSONL of id and text; finished ids are skipped")
    args = parser.parse_args()

    server = address(args.stt)
    print("labels from", describe(server, "asr"), file=sys.stderr)
    clips = read_rows(args.clips)
    done = set(read_rows(args.out)) if args.out.exists() and args.out.stat().st_size else set()
    if done - clips.keys():
        raise ValueError("output contains ids absent from the clips manifest")
    with args.out.open("a", encoding="utf-8") as out:
        for row in clips.values():
            if row["id"] in done:
                continue
            pcm, rate = sf.read(row["wav"], dtype="int16")
            if rate != 16000 or pcm.ndim != 1:
                raise ValueError("expected 16 kHz mono audio")
            text = transcribe(server, pcm.tobytes(), "en")
            if not text.strip():
                raise ValueError("server returned an empty transcript")
            out.write(json.dumps({"id": row["id"], "text": text}) + "\n")
            out.flush()
            done.add(row["id"])
            print(f"labeled {len(done)}/{len(clips)} clips", file=sys.stderr)


if __name__ == "__main__":
    main()
