import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluate


@pytest.fixture(autouse=True)
def offline_normalizer(tmp_path, monkeypatch):
    spelling = tmp_path / "normalizer.json"
    spelling.write_text("{}")
    monkeypatch.setattr(evaluate, "hf_hub_download", lambda *args, **kwargs: str(spelling))


def prediction(clip_id, text, cap=False):
    return {"id": clip_id, "text": text, "audio_ctx": 160, "seconds": 1.0, "tokens": 3, "max_tokens_reached": cap}


def test_corpus_wer_counts_deletions_and_silent_reference_insertions():
    rows = [{"id": "a", "text": "cats chase birds"}, {"id": "b", "text": "!!!"}]
    metrics, _ = evaluate.score(rows, [prediction("a", "cats birds"), prediction("b", "extra word")])
    assert metrics["reference_words"] == 3
    assert metrics["deletions"] == 1
    assert metrics["insertions"] == 2
    assert metrics["wer"] == 1.0


def test_missing_duplicate_and_orphan_predictions_rejected():
    rows = [{"id": "a", "text": "one"}, {"id": "b", "text": "two"}]
    for predictions in (
        [prediction("a", "one")],
        [prediction("a", "one"), prediction("a", "one")],
        [prediction("a", "one"), prediction("c", "two")],
    ):
        with pytest.raises(ValueError):
            evaluate.score(rows, predictions)


def test_loop_and_cap_reported():
    rows = [{"id": "a", "text": "hello"}, {"id": "b", "text": "words"}]
    metrics, clips = evaluate.score(
        rows, [prediction("a", "hello hello hello hello", True), prediction("b", "words are here")]
    )
    assert metrics["possible_loops"] == 1
    assert metrics["possible_token_caps"] == 1
    assert [row["possible_loop"] for row in clips] == [True, False]


def test_manifest_failure_stops_before_decoding(tmp_path, monkeypatch):
    clips = tmp_path / "clips.jsonl"
    labels = tmp_path / "labels.jsonl"
    clips.write_text("\n".join(json.dumps({"id": clip_id}) for clip_id in ("a", "b")))
    labels.write_text(json.dumps({"id": "a", "text": "word"}))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "evaluate.py",
            "--clips",
            str(clips),
            "--labels",
            str(labels),
            "--model",
            "model",
            "--decoder",
            "decoder",
            "--split",
            "val",
            "--metrics",
            str(tmp_path / "metrics"),
            "--predictions",
            str(tmp_path / "predictions"),
        ],
    )
    with pytest.raises(ValueError, match="label coverage mismatch"):
        evaluate.main()
    assert not (tmp_path / "metrics").exists()
    assert not (tmp_path / "predictions").exists()


def test_end_to_end_writes_private_results(tmp_path, monkeypatch, capsys):
    import wave

    wav = tmp_path / "clip.wav"
    with wave.open(str(wav), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 8000)
    clips, labels = tmp_path / "clips.jsonl", tmp_path / "labels.jsonl"
    clips.write_text(json.dumps({"id": "a", "recording": "r", "split": "val", "wav": str(wav), "seconds": 0.5}))
    labels.write_text(json.dumps({"id": "a", "text": "cats chase birds"}))
    model, decoder = tmp_path / "model", tmp_path / "decoder"
    model.write_bytes(b"model")
    decoder.write_bytes(b"decoder")
    decoded = prediction("a", "cats birds")
    del decoded["id"]
    monkeypatch.setattr(
        evaluate.subprocess,
        "run",
        lambda *args, **kwargs: types.SimpleNamespace(returncode=0, stdout=json.dumps(decoded)),
    )
    metrics, predictions = tmp_path / "metrics", tmp_path / "predictions"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "evaluate.py",
            "--clips",
            str(clips),
            "--labels",
            str(labels),
            "--model",
            str(model),
            "--decoder",
            str(decoder),
            "--split",
            "val",
            "--metrics",
            str(metrics),
            "--predictions",
            str(predictions),
        ],
    )
    evaluate.main()
    assert json.loads(metrics.read_text())["deletions"] == 1
    assert json.loads(predictions.read_text())["text"] == "cats birds"
    assert metrics.stat().st_mode & 0o777 == 0o600
    assert predictions.stat().st_mode & 0o777 == 0o600
    assert capsys.readouterr().out == ""
