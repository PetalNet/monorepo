"""Score every clip in one held-out split with the CPU decoder."""

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

import jiwer
from huggingface_hub import hf_hub_download
from transformers.models.whisper.english_normalizer import EnglishTextNormalizer


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def looping(text: str) -> bool:
    words = text.split()
    return any(
        words[i : i + size] * 4 == words[i : i + size * 4]
        for size in range(1, 6)
        for i in range(len(words) - size * 4 + 1)
    )


def score(rows: list[dict], predictions: list[dict]) -> tuple[dict, list[dict]]:
    by_id = {}
    for prediction in predictions:
        clip_id = prediction["id"]
        if clip_id in by_id:
            raise ValueError("duplicate prediction id")
        by_id[clip_id] = prediction
    if len({row["id"] for row in rows}) != len(rows) or set(by_id) != {row["id"] for row in rows}:
        raise ValueError("prediction ids do not match selected manifest")
    if not rows:
        raise ValueError("selected split is empty")
    spelling = hf_hub_download(
        "openai/whisper-tiny.en", "normalizer.json", revision="87c7102498dcde7456f24cfd30239ca606ed9063", token=False
    )
    normalize = EnglishTextNormalizer(json.loads(Path(spelling).read_text()))
    refs, hyps, results = [], [], []
    for row in rows:
        pred = by_id[row["id"]]
        ref, hyp = normalize(row["text"]), normalize(pred["text"])
        refs.append(ref)
        hyps.append(hyp)
        results.append(
            {
                **pred,
                "reference": row["text"],
                "normalized_reference": ref,
                "normalized_prediction": hyp,
                "possible_loop": looping(hyp),
            }
        )
    words = jiwer.process_words(refs, hyps)
    denominator = words.hits + words.substitutions + words.deletions
    metrics = {
        "clips": len(rows),
        "reference_words": denominator,
        "hits": words.hits,
        "substitutions": words.substitutions,
        "deletions": words.deletions,
        "insertions": words.insertions,
        "wer": words.wer if denominator else None,
        "possible_loops": sum(row["possible_loop"] for row in results),
        "possible_token_caps": sum(row["max_tokens_reached"] for row in results),
    }
    return metrics, results


def write_private(path: Path, content: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("clips", "labels", "model", "decoder", "metrics", "predictions"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--audio-root", type=Path)
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--split", choices=("val", "test"), required=True)
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("--threads must be positive")
    if args.metrics.resolve() == args.predictions.resolve():
        parser.error("--metrics and --predictions must differ")
    if args.metrics.exists() or args.predictions.exists():
        parser.error("output files must not already exist")
    from data import load_dataset

    rows = [r for r in load_dataset(args.clips, args.labels, args.audio_root) if r["split"] == args.split]
    if not rows:
        raise ValueError("selected split is empty")
    predictions = []
    for row in rows:
        command = [
            str(args.decoder.resolve()),
            "--model",
            str(args.model),
            "--wav",
            str(row["wav"]),
            "--threads",
            str(args.threads),
        ]
        if args.prompt_file:
            command += ["--prompt-file", str(args.prompt_file)]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode:
            raise RuntimeError(f"decoder failed for clip {row['id']} (exit {result.returncode})")
        decoded = json.loads(result.stdout)
        if (
            not isinstance(decoded.get("text"), str)
            or type(decoded.get("tokens")) is not int
            or type(decoded.get("max_tokens_reached")) is not bool
            or type(decoded.get("audio_ctx")) is not int
            or not isinstance(decoded.get("seconds"), (int, float))
        ):
            raise ValueError("invalid decoder output")
        predictions.append({"id": row["id"], **decoded})
    metrics, results = score(rows, predictions)
    metrics.update(
        {
            "split": args.split,
            "model_sha256": sha256(args.model),
            "decoder_sha256": sha256(args.decoder),
            "prompt_sha256": sha256(args.prompt_file) if args.prompt_file else None,
            "settings": {
                "threads": args.threads,
                "cpu": True,
                "language": "en",
                "beam_size": 5,
                "best_of": 5,
                "temperature_inc": 0,
                "suppress_blank": False,
                "suppress_non_speech_tokens": True,
                "max_tokens": 256,
                "audio_ctx": "clamp(ceil(samples / 320) + 32, 160, 1500)",
                "no_timestamps": "samples < 400000",
            },
        }
    )
    write_private(args.predictions, "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in results))
    write_private(args.metrics, json.dumps(metrics, indent=2) + "\n")


if __name__ == "__main__":
    main()
