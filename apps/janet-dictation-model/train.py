"""Fine-tune a FUTO ACFT Whisper model with short audio contexts."""

import argparse
import hashlib
import json
import math
import os
import random
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"
os.environ["WANDB_DISABLED"] = "true"
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
import transformers
from transformers import WhisperForConditionalGeneration, WhisperProcessor, get_linear_schedule_with_warmup
from transformers.modeling_outputs import BaseModelOutput

MODELS = ("futo-org/acft-whisper-base.en", "futo-org/acft-whisper-small.en")
RATE = 16000


def audio_context(samples: int) -> int:
    return max(160, min(1500, math.ceil(samples / 320) + 32))


def partial_encoder(encoder, features, context):
    """Apply the Whisper encoder to the context used by FUTO's ACFT runtime."""
    length = 2 * context
    features = F.pad(features, (0, max(0, length - features.shape[-1])))[..., :length]
    hidden = F.gelu(encoder.conv1(features))
    hidden = F.gelu(encoder.conv2(hidden)).permute(0, 2, 1)
    hidden = hidden + encoder.embed_positions.weight[:context]
    hidden = F.dropout(hidden, p=encoder.dropout, training=encoder.training)
    for layer in encoder.layers:
        if encoder.training and torch.rand(()) < encoder.layerdrop:
            continue
        hidden = layer(hidden, attention_mask=None, layer_head_mask=None)[0]
    return encoder.layer_norm(hidden)


def example_loss(model, processor, waveform, text, prompt_ids=None, augment=False):
    if len(waveform) > 30 * RATE:
        raise ValueError("audio exceeds Whisper's 30-second limit")
    features = processor.feature_extractor(waveform, sampling_rate=RATE, return_tensors="pt").input_features
    context = audio_context(len(waveform))
    features = features[..., : 2 * context].to(model.device)
    if augment:
        features = features.clone()
        width = min(20, features.shape[-1])
        start = torch.randint(features.shape[-1] - width + 1, ()).item()
        features[..., start : start + width] = 0
        width = min(4, features.shape[-2])
        start = torch.randint(features.shape[-2] - width + 1, ()).item()
        features[:, start : start + width, :] = 0
    tokens = list(prompt_ids or []) + processor.tokenizer(text).input_ids
    if len(tokens) - 1 > model.config.max_target_positions:
        raise ValueError("transcript and prompt exceed Whisper's decoder context")
    ids = torch.tensor([tokens], dtype=torch.long, device=model.device)
    labels = ids[:, 1:].clone()
    labels[:, : len(prompt_ids or [])] = -100
    hidden = partial_encoder(model.model.encoder, features, context)
    return model(encoder_outputs=BaseModelOutput(last_hidden_state=hidden),
                 decoder_input_ids=ids[:, :-1], labels=labels, use_cache=False).loss


def in_night_window(now=None):
    now = now or datetime.now(ZoneInfo("America/Chicago"))
    local = now.astimezone(ZoneInfo("America/Chicago"))
    return local.hour >= 23 or local.hour < 7


def configure_gpu(policy, fraction):
    if not 0 < fraction <= 1:
        raise ValueError("--memory-fraction must be greater than zero and at most 1")
    if policy == "3080-night" and not in_night_window():
        raise RuntimeError("3080-night runs only between 23:00 and 07:00 America/Chicago")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required")
    name = torch.cuda.get_device_name(0)
    expected = "4090" if policy == "4090" else "3080"
    if not re.search(rf"\bRTX\s+{expected}\b", name, re.IGNORECASE):
        raise RuntimeError(f"GPU policy {policy} does not match device {name!r}")
    torch.cuda.set_per_process_memory_fraction(fraction, 0)
    return name


def rng_state():
    return {"python": random.getstate(), "numpy": np.random.get_state(),
            "torch": torch.get_rng_state(), "cuda": torch.cuda.get_rng_state_all()}


def restore_rng(state):
    random.setstate(state["python"])
    np.random.set_state(state["numpy"])
    torch.set_rng_state(state["torch"].cpu())
    torch.cuda.set_rng_state_all(state["cuda"])


def save_last(path, model, optimizer, scheduler, scaler, state, signature):
    checkpoint = {"model": model.state_dict(), "optimizer": optimizer.state_dict(),
                  "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(),
                  "gradients": {name: p.grad for name, p in model.named_parameters() if p.grad is not None},
                  "rng": rng_state(), "state": state, "signature": signature}
    temporary = path.with_suffix(".tmp")
    torch.save(checkpoint, temporary)
    os.replace(temporary, path)


def load_last(path, model, optimizer, scheduler, scaler, signature):
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    if checkpoint["signature"] != signature:
        raise ValueError("resume configuration or input files differ from the checkpoint")
    model.load_state_dict(checkpoint["model"])
    optimizer.load_state_dict(checkpoint["optimizer"])
    scheduler.load_state_dict(checkpoint["scheduler"])
    scaler.load_state_dict(checkpoint["scaler"])
    for name, parameter in model.named_parameters():
        gradient = checkpoint["gradients"].get(name)
        parameter.grad = gradient.to(parameter.device) if gradient is not None else None
    restore_rng(checkpoint["rng"])
    return checkpoint["state"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clips", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--audio-root", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", choices=MODELS, default=MODELS[0])
    parser.add_argument("--gpu", choices=("4090", "3080-night"), required=True)
    parser.add_argument("--memory-fraction", type=float, default=0.8)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--accumulation", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--spec-augment", action="store_true")
    parser.add_argument("--prompt", type=Path, help="optional UTF-8 private vocabulary prompt")
    parser.add_argument("--resume", type=Path, help="trusted last.pt checkpoint")
    args = parser.parse_args()
    if args.epochs < 1 or args.accumulation < 1 or not math.isfinite(args.learning_rate) or args.learning_rate <= 0:
        parser.error("epochs, accumulation, and learning rate must be positive")
    if args.resume is None and (args.output / "last.pt").exists():
        parser.error("output already contains last.pt; pass --resume or use another output")
    if transformers.__version__ != "4.46.3":
        raise RuntimeError("install transformers==4.46.3 for the verified Whisper encoder interface")
    if args.resume and args.resume.resolve().parent != args.output.resolve():
        parser.error("--resume must point to last.pt inside --output")
    gpu_name = configure_gpu(args.gpu, args.memory_fraction)
    from data import load_dataset

    rows = load_dataset(args.clips, args.labels, args.audio_root)
    train = [row for row in rows if row["split"] == "train"]
    val = [row for row in rows if row["split"] == "val"]
    if not train or not val:
        raise ValueError("training and validation splits must both be nonempty")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.use_deterministic_algorithms(True)
    processor_model = args.model.replace("futo-org/acft-", "openai/")
    processor = WhisperProcessor.from_pretrained(processor_model, token=False)
    model = WhisperForConditionalGeneration.from_pretrained(args.model, token=False).cuda()
    prompt_ids = processor.get_prompt_ids(args.prompt.read_text(encoding="utf-8").strip()).tolist() if args.prompt else []
    steps_per_epoch = math.ceil(len(train) / args.accumulation)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    scheduler = get_linear_schedule_with_warmup(optimizer, 0, steps_per_epoch * args.epochs)
    scaler = torch.amp.GradScaler("cuda")
    config = {"model": args.model, "processor": processor_model, "epochs": args.epochs, "accumulation": args.accumulation,
              "learning_rate": args.learning_rate, "seed": args.seed, "spec_augment": args.spec_augment,
              "prompt": bool(args.prompt), "batch_size": 1, "gpu_policy": args.gpu,
              "memory_fraction": args.memory_fraction, "transformers": transformers.__version__,
              "torch": torch.__version__, "model_revision": model.config._commit_hash}
    signature = {"config": config, "clips_sha256": digest(args.clips), "labels_sha256": digest(args.labels),
                 "prompt_sha256": digest(args.prompt) if args.prompt else None,
                 "audio_root": str(args.audio_root.resolve()) if args.audio_root else None}
    args.output.mkdir(parents=True, exist_ok=True)
    state = {"epoch": 0, "step": 0, "best_loss": float("inf")}
    if args.resume:
        state = load_last(args.resume, model, optimizer, scheduler, scaler, signature)
    else:
        optimizer.zero_grad(set_to_none=True)
    (args.output / "run.json").write_text(json.dumps({"config": config, "gpu": gpu_name,
        "train_clips": len(train), "val_clips": len(val)}, indent=2) + "\n")
    last = args.output / "last.pt"

    def stop_if_needed():
        if args.gpu == "3080-night" and not in_night_window():
            save_last(last, model, optimizer, scheduler, scaler, state, signature)
            print("Night window ended; saved resumable last.pt.", flush=True)
            return True
        return False

    def loss_for(row, augment):
        waveform, rate = sf.read(str(row["wav"]), dtype="float32")
        if rate != RATE or waveform.ndim != 1:
            raise ValueError("expected mono 16 kHz WAV")
        with torch.autocast(device_type="cuda", dtype=torch.float16):
            return example_loss(model, processor, waveform, row["text"], prompt_ids, augment)

    while state["epoch"] < args.epochs:
        epoch = state["epoch"]
        order = list(range(len(train)))
        random.Random(args.seed + epoch).shuffle(order)
        model.train()
        for step in range(state["step"], len(order)):
            if stop_if_needed():
                return
            # The final accumulation group may be shorter than the configured size.
            group_start = (step // args.accumulation) * args.accumulation
            group_size = min(args.accumulation, len(order) - group_start)
            loss = loss_for(train[order[step]], args.spec_augment) / group_size
            scaler.scale(loss).backward()
            state["step"] = step + 1
            if state["step"] % args.accumulation == 0 or state["step"] == len(order):
                old_scale = scaler.get_scale()
                scaler.step(optimizer)
                scaler.update()
                if scaler.get_scale() >= old_scale:
                    scheduler.step()
                optimizer.zero_grad(set_to_none=True)
        model.eval()
        losses = []
        with torch.no_grad():
            for row in val:
                if stop_if_needed():
                    return
                losses.append(loss_for(row, False).item())
        if stop_if_needed():
            return
        validation_loss = sum(losses) / len(losses)
        if not math.isfinite(validation_loss):
            raise RuntimeError("validation loss is not finite")
        if validation_loss < state["best_loss"]:
            state["best_loss"] = validation_loss
            model.save_pretrained(args.output / "best", safe_serialization=True)
            processor.save_pretrained(args.output / "best")
        print(f"epoch {epoch + 1}: validation loss {validation_loss:.6f}", flush=True)
        state.update(epoch=epoch + 1, step=0)
        save_last(last, model, optimizer, scheduler, scaler, state, signature)


if __name__ == "__main__":
    main()
