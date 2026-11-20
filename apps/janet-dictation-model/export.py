"""Convert a local Hugging Face Whisper checkpoint to whisper.cpp Q8_0."""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from huggingface_hub import hf_hub_download
from safetensors.torch import load_file, save_file


def load_tied_weights(path: Path) -> dict:
    weights = load_file(path)
    # FUTO's GGML binaries use the output projection as the shared token embedding.
    if "proj_out.weight" in weights:
        weights["model.decoder.embed_tokens.weight"] = weights.pop("proj_out.weight")
    return weights


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--whisper-cpp", type=Path, required=True)
    parser.add_argument("--quantize", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--tokenizer-repo", default="openai/whisper-tiny.en")
    args = parser.parse_args()
    checkpoint, out = args.checkpoint.resolve(), args.out.resolve()
    if not (checkpoint / "config.json").is_file() or not (checkpoint / "model.safetensors").is_file():
        parser.error("--checkpoint must contain config.json and model.safetensors")
    if out.exists():
        parser.error("--out already exists")
    out.parent.mkdir(parents=True, exist_ok=True)
    import whisper

    whisper_dir = Path(whisper.__file__).resolve().parent.parent
    if not (whisper_dir / "whisper/assets/mel_filters.npz").is_file():
        raise FileNotFoundError("installed openai-whisper is missing mel filters")
    converter = args.whisper_cpp.resolve() / "models/convert-h5-to-ggml.py"
    with tempfile.TemporaryDirectory(prefix=".whisper-export-", dir=out.parent) as tmp:
        root = Path(tmp)
        staged = root / "model"
        staged.mkdir(mode=0o700)
        for path in checkpoint.iterdir():
            if path.is_file() and path.name != "model.safetensors":
                (staged / path.name).symlink_to(path)
        save_file(
            load_tied_weights(checkpoint / "model.safetensors"), staged / "model.safetensors", metadata={"format": "pt"}
        )
        for name in ("vocab.json", "added_tokens.json"):
            if not (staged / name).exists():
                source = hf_hub_download(repo_id=args.tokenizer_repo, filename=name, token=False)
                shutil.copyfile(source, staged / name)
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
        subprocess.run([sys.executable, str(converter), str(staged), str(whisper_dir), str(root)], check=True, env=env)
        quantized = root / "quantized.bin"
        subprocess.run([str(args.quantize.resolve()), str(root / "ggml-model.bin"), str(quantized), "q8_0"], check=True)
        os.chmod(quantized, 0o600)
        os.link(quantized, out)


if __name__ == "__main__":
    main()
