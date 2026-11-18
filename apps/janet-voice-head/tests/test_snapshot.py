import json
import tempfile
import unittest
from pathlib import Path

from janet_voice_head import snapshot


def record(uuid: str, **extra) -> str:
    return json.dumps({"uuid": uuid, "parentUuid": None, "type": "user", **extra}, separators=(",", ":"))


def boundary(uuid: str) -> str:
    return json.dumps({"parentUuid": None, "type": "system", "subtype": "compact_boundary", "uuid": uuid}, separators=(",", ":"))


def kept_boundary(uuid: str, head: str, tail: str) -> str:
    return json.dumps({"parentUuid": None, "type": "system", "subtype": "compact_boundary", "uuid": uuid,
                       "compactMetadata": {"preservedSegment": {"headUuid": head, "anchorUuid": "summary", "tailUuid": tail}}},
                      separators=(",", ":"))


def linked(uuid: str, parent: str | None, **extra) -> str:
    return json.dumps({"uuid": uuid, "parentUuid": parent, "type": "assistant", **extra}, separators=(",", ":"))


class TrimTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.source = self.dir / "main.jsonl"

    def write(self, *lines: str) -> None:
        self.source.write_text("".join(line + "\n" for line in lines))

    def trimmed(self, max_bytes=1 << 30) -> list[dict] | None:
        session_id = snapshot.write_trimmed(self.source, self.dir / "fork", max_bytes)
        if session_id is None:
            return None
        return [json.loads(line) for line in (self.dir / "fork" / f"{session_id}.jsonl").read_text().splitlines()]

    def test_the_copy_starts_at_the_last_compact_boundary(self):
        self.write(record("a"), boundary("b1"), record("c"), boundary("b2"), record("d"), record("e"))
        self.assertEqual([r["uuid"] for r in self.trimmed()], ["b2", "d", "e"])

    def test_text_that_merely_mentions_a_boundary_is_not_one(self):
        self.write(boundary("b1"), record("c"), record("d", note='the "subtype":"compact_boundary" marker, quoted'))
        self.assertEqual([r["uuid"] for r in self.trimmed()], ["b1", "c", "d"])

    def test_a_boundary_far_back_across_many_windows_is_found(self):
        filler = [record(f"f{i}", pad="x" * 1000) for i in range(int(snapshot.WINDOW * 2.5 / 1000))]
        self.write(record("a"), boundary("b"), *filler)
        copy = self.trimmed()
        self.assertEqual((copy[0]["uuid"], len(copy)), ("b", len(filler) + 1))

    def test_no_boundary_within_the_limit_gives_nothing(self):
        self.write(boundary("b"), *[record(f"f{i}", pad="x" * 1000) for i in range(50)])
        self.assertIsNone(self.trimmed(max_bytes=20000))

    def test_the_records_a_compaction_kept_from_before_it_come_first_in_the_copy(self):
        self.write(record("old"), linked("k1", "old"), linked("k2", "k1"), linked("k3", "k2"), record("gap"), kept_boundary("b", "k1", "k3"), record("c"))
        self.assertEqual([r["uuid"] for r in self.trimmed()], ["k1", "k2", "k3", "b", "c"])

    def test_kept_records_further_back_than_a_window_are_found(self):
        filler = [record(f"f{i}", pad="x" * 1000) for i in range(int(snapshot.WINDOW * 2.2 / 1000))]
        self.write(linked("k1", None, big="y" * 5000), linked("k2", "k1"), *filler, kept_boundary("b", "k1", "k2"), record("c"))
        self.assertEqual([r["uuid"] for r in self.trimmed()][:3], ["k1", "k2", "b"])

    def test_a_chain_that_cannot_be_found_gives_no_copy(self):
        self.write(record("x"), kept_boundary("b", "missing-head", "missing-tail"), record("c"))
        self.assertIsNone(self.trimmed())

    def test_a_compaction_that_kept_nothing_needs_no_extra_records(self):
        self.write(record("old"), boundary("b"), record("c"))
        self.assertEqual([r["uuid"] for r in self.trimmed()], ["b", "c"])

    def test_the_source_is_left_alone(self):
        self.write(record("a"), boundary("b"), record("c"))
        before = self.source.read_bytes()
        self.trimmed()
        self.assertEqual(self.source.read_bytes(), before)

    def test_pruning_deletes_only_the_copies_it_made(self):
        self.write(boundary("b"))
        made = snapshot.write_trimmed(self.source, self.dir / "fork", 1 << 30)
        other = self.dir / "fork" / "someone-elses.jsonl"
        other.write_text("{}\n")
        manifest = self.dir / "manifest"
        snapshot.remember(manifest, made)
        snapshot.prune(self.dir / "fork", manifest, -1)
        self.assertFalse((self.dir / "fork" / f"{made}.jsonl").exists())
        self.assertTrue(other.exists())

    def test_a_torn_manifest_line_and_the_copy_in_use_are_survived(self):
        self.write(boundary("b"))
        made = snapshot.write_trimmed(self.source, self.dir / "fork", 1 << 30)
        manifest = self.dir / "manifest"
        snapshot.remember(manifest, made)
        manifest.write_text(manifest.read_text() + "12")
        snapshot.prune(self.dir / "fork", manifest, -1, keep=made)
        self.assertTrue((self.dir / "fork" / f"{made}.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
