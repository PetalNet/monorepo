import json
from pathlib import Path
import tempfile
import unittest
import wave

from data import load_dataset


class DataTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "train").mkdir()
        self.wav = self.root / "train" / "note.wav"
        with wave.open(str(self.wav), "wb") as out:
            out.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            out.writeframes(b"\0\0" * 16000)
        self.clips, self.labels = self.root / "clips.jsonl", self.root / "labels.jsonl"
        self.row = {"id": "note", "recording": "whole-note", "split": "train",
                    "wav": r"C:\private\train\note.wav", "seconds": 1.0}
        self.clips.write_text(json.dumps(self.row) + "\n")
        self.labels.write_text(json.dumps({"id": "note", "text": "A synthetic test."}) + "\n")

    def load(self):
        return load_dataset(self.clips, self.labels, self.root)

    def test_windows_manifest_maps_to_local_audio(self):
        self.assertEqual(self.load()[0]["wav"], self.wav)

    def test_duplicate_label_rejected(self):
        self.labels.write_text(self.labels.read_text() * 2)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.load()

    def test_missing_and_orphan_labels_rejected(self):
        self.labels.write_text('{"id":"elsewhere","text":"Missing."}\n')
        with self.assertRaisesRegex(ValueError, "1 missing, 1 orphan"):
            self.load()

    def test_recording_leakage_rejected(self):
        self.clips.write_text(self.clips.read_text() + json.dumps({**self.row, "id": "leak", "split": "test"}))
        self.labels.write_text(self.labels.read_text() + '{"id":"leak","text":"Same recording."}\n')
        with self.assertRaisesRegex(ValueError, "more than one split"):
            self.load()

    def test_duration_mismatch_rejected(self):
        self.clips.write_text(json.dumps({**self.row, "seconds": 2}))
        with self.assertRaisesRegex(ValueError, "duration mismatch"):
            self.load()

    def test_truncated_wav_rejected(self):
        self.wav.write_bytes(self.wav.read_bytes()[:-100])
        with self.assertRaisesRegex(ValueError, "truncated"):
            self.load()


if __name__ == "__main__":
    unittest.main()
