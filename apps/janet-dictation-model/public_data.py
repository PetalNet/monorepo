"""Download a deterministic, small LibriSpeech test-clean sample for a regression check."""

import argparse
import io
import json
import random
from pathlib import Path

import pyarrow.parquet as pq
import soundfile as sf
from huggingface_hub import hf_hub_download

REVISION = "71cacbfb7e2354c4226d01e70d77d5fca3d04ba1"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--count", type=int, default=40)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    parquet = hf_hub_download(
        "openslr/librispeech_asr", "clean/test/0000.parquet", repo_type="dataset", revision=REVISION, token=False
    )
    table = pq.read_table(parquet)
    total = len(table)
    if not 1 <= args.count <= total:
        parser.error("count must be between one and the dataset size")
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "clips" / "test").mkdir(parents=True)
    indices = list(range(total))
    random.Random(args.seed).shuffle(indices)
    clips, labels, speakers, selected = [], [], set(), []
    for index in indices:
        row = table.slice(index, 1).to_pylist()[0]
        waveform, rate = sf.read(io.BytesIO(row["audio"]["bytes"]), dtype="float32")
        seconds = len(waveform) / rate
        if rate != 16000 or waveform.ndim != 1:
            raise ValueError("unexpected LibriSpeech audio format")
        if not 0.5 <= seconds <= 30:
            continue
        wav = (args.out / "clips" / "test" / (row["id"] + ".wav")).resolve()
        sf.write(wav, waveform, rate, subtype="PCM_16")
        clips.append({"id": row["id"], "recording": row["id"], "split": "test", "wav": str(wav), "seconds": seconds})
        labels.append({"id": row["id"], "text": row["text"]})
        speakers.add(row["speaker_id"])
        selected.append(index)
        if len(clips) == args.count:
            break
    if len(clips) != args.count:
        raise ValueError("not enough clips within the supported duration range")
    for name, content in (("clips.jsonl", clips), ("labels.jsonl", labels)):
        (args.out / name).write_text("".join(json.dumps(row) + "\n" for row in content))
    provenance = {
        "dataset": "openslr/librispeech_asr",
        "revision": REVISION,
        "config": "clean",
        "split": "test",
        "seed": args.seed,
        "row_indices": selected,
        "clips": len(clips),
        "speakers": len(speakers),
        "seconds": sum(row["seconds"] for row in clips),
    }
    (args.out / "source.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps(provenance))


if __name__ == "__main__":
    main()
