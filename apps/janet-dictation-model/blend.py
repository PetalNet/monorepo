"""Interpolate an adapted checkpoint with its unmodified ACFT weights before re-evaluation."""

import argparse
import json
import math
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download
from safetensors.torch import save_file

from evaluate import sha256
from export import load_tied_weights


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapted", type=Path, required=True)
    parser.add_argument(
        "--base", choices=("futo-org/acft-whisper-base.en", "futo-org/acft-whisper-small.en"), required=True
    )
    parser.add_argument("--base-revision", required=True, help="exact base revision from the training run.json")
    parser.add_argument("--alpha", type=float, required=True, help="fraction of adapted weights to retain")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not math.isfinite(args.alpha) or not 0 <= args.alpha <= 1:
        parser.error("alpha must be between zero and one")
    base_path = Path(hf_hub_download(args.base, "model.safetensors", revision=args.base_revision, token=False))
    adapted_path = args.adapted / "model.safetensors"
    base, adapted = load_tied_weights(base_path), load_tied_weights(adapted_path)
    if base.keys() != adapted.keys():
        raise ValueError("base and adapted tensor names differ")
    for name, tensor in adapted.items():
        if tensor.shape != base[name].shape:
            raise ValueError("base and adapted tensor shapes differ")
        adapted[name] = base[name].float().lerp(tensor.float(), args.alpha)
    args.out.mkdir(parents=True, exist_ok=False)
    for path in args.adapted.iterdir():
        if path.is_file() and path.suffix in {".json", ".txt"}:
            shutil.copyfile(path, args.out / path.name)
    save_file(adapted, args.out / "model.safetensors", metadata={"format": "pt"})
    (args.out / "blend.json").write_text(
        json.dumps(
            {
                "base": args.base,
                "base_revision": args.base_revision,
                "alpha": args.alpha,
                "base_sha256": sha256(base_path),
                "adapted_sha256": sha256(adapted_path),
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
