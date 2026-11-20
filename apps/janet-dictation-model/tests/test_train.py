from datetime import UTC, datetime
from types import SimpleNamespace

import numpy as np
import pytest
import torch
from transformers import WhisperConfig, WhisperFeatureExtractor, WhisperForConditionalGeneration

import train


def tiny_model():
    config = WhisperConfig(
        vocab_size=32,
        num_mel_bins=80,
        d_model=16,
        encoder_layers=1,
        decoder_layers=1,
        encoder_attention_heads=2,
        decoder_attention_heads=2,
        encoder_ffn_dim=32,
        decoder_ffn_dim=32,
        max_source_positions=1500,
        max_target_positions=32,
        pad_token_id=0,
        bos_token_id=1,
        eos_token_id=2,
        decoder_start_token_id=1,
        dropout=0.0,
        attention_dropout=0.0,
    )
    return WhisperForConditionalGeneration(config)


def test_context_boundaries():
    assert train.audio_context(1) == 160
    assert train.audio_context(40960) == 160
    assert train.audio_context(40961) == 161
    assert train.audio_context(480000) == 1500


def test_partial_encoder_matches_standard_encoder_at_full_context():
    model = tiny_model().eval()
    features = torch.randn(1, 80, 3000)
    with torch.no_grad():
        expected = model.model.encoder(features).last_hidden_state
        actual = train.partial_encoder(model.model.encoder, features, 1500)
    torch.testing.assert_close(actual, expected)


def test_synthetic_audio_forward_backward_and_export(tmp_path):
    model = tiny_model().train()

    class Tokenizer:
        def __call__(self, text):
            return SimpleNamespace(input_ids=[1, 3, 4, 2])

    processor = SimpleNamespace(feature_extractor=WhisperFeatureExtractor(), tokenizer=Tokenizer())
    audio = np.zeros(16000, dtype=np.float32)
    loss = train.example_loss(model, processor, audio, "synthetic", [5, 6], augment=True)
    assert torch.isfinite(loss)
    loss.backward()
    assert model.model.encoder.conv1.weight.grad is not None
    assert torch.isfinite(model.model.encoder.conv1.weight.grad).all()
    assert model.model.encoder.conv1.weight.grad.abs().sum() > 0
    model.save_pretrained(tmp_path)
    loaded = WhisperForConditionalGeneration.from_pretrained(tmp_path)
    torch.testing.assert_close(loaded.model.encoder.conv1.weight, model.model.encoder.conv1.weight)


@pytest.mark.parametrize(("hour", "minute", "allowed"), [(4, 59, False), (5, 0, True), (12, 59, True), (13, 0, False)])
def test_chicago_night_window(hour, minute, allowed):
    # January Chicago is UTC-6; UTC dates straddle local midnight.
    instant = datetime(2026, 1, 2, hour, minute, tzinfo=UTC)
    assert train.in_night_window(instant) is allowed


def test_gpu_policy_checks_device_and_caps_memory(monkeypatch):
    calls = []
    monkeypatch.setattr(train.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(train.torch.cuda, "get_device_name", lambda _: "NVIDIA GeForce RTX 4090")
    monkeypatch.setattr(train.torch.cuda, "set_per_process_memory_fraction", lambda *a: calls.append(a))
    assert train.configure_gpu("4090", 0.7) == "NVIDIA GeForce RTX 4090"
    assert calls == [(0.7, 0)]
    monkeypatch.setattr(train, "in_night_window", lambda: False)
    with pytest.raises(RuntimeError, match="23:00"):
        train.configure_gpu("3080-night", 0.7)
    monkeypatch.setattr(train, "in_night_window", lambda: True)
    with pytest.raises(RuntimeError, match="does not match"):
        train.configure_gpu("3080-night", 0.7)
    assert calls == [(0.7, 0)]


def test_resume_restores_gradients_optimizer_scheduler_scaler_and_rng(tmp_path, monkeypatch):
    monkeypatch.setattr(train.torch.cuda, "get_rng_state_all", list)
    monkeypatch.setattr(train.torch.cuda, "set_rng_state_all", lambda _: None)
    torch.manual_seed(12)
    model = torch.nn.Linear(2, 1)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.01)
    scheduler = torch.optim.lr_scheduler.StepLR(optimizer, 1)
    scaler = torch.amp.GradScaler("cpu")
    scaler.scale(model(torch.ones(1, 2)).sum()).backward()
    state = {"epoch": 0, "step": 1, "best_loss": 1.0}
    path = tmp_path / "last.pt"
    train.save_last(path, model, optimizer, scheduler, scaler, state, {"input": "same"})
    expected_random = torch.rand(3)
    scaler.scale(model(torch.ones(1, 2) * 2).sum()).backward()
    scaler.step(optimizer)
    scaler.update()
    scheduler.step()
    expected = [p.detach().clone() for p in model.parameters()]
    resumed = torch.nn.Linear(2, 1)
    resumed_optimizer = torch.optim.AdamW(resumed.parameters(), lr=0.01)
    resumed_scheduler = torch.optim.lr_scheduler.StepLR(resumed_optimizer, 1)
    resumed_scaler = torch.amp.GradScaler("cpu")
    assert (
        train.load_last(path, resumed, resumed_optimizer, resumed_scheduler, resumed_scaler, {"input": "same"}) == state
    )
    torch.testing.assert_close(torch.rand(3), expected_random)
    resumed_scaler.scale(resumed(torch.ones(1, 2) * 2).sum()).backward()
    resumed_scaler.step(resumed_optimizer)
    resumed_scaler.update()
    resumed_scheduler.step()
    for actual, wanted in zip(resumed.parameters(), expected):
        torch.testing.assert_close(actual, wanted)
    assert resumed_scheduler.state_dict() == scheduler.state_dict()
    assert resumed_scaler.state_dict() == scaler.state_dict()
    with pytest.raises(ValueError, match="differ"):
        train.load_last(path, resumed, resumed_optimizer, resumed_scheduler, resumed_scaler, {"input": "different"})
