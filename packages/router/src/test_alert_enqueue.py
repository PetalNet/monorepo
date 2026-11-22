import concurrent.futures
import json
from pathlib import Path
import tempfile
import unittest

from alert_enqueue import enqueue


class AlertEnqueueTests(unittest.TestCase):
    def test_same_event_is_queued_once_concurrently_and_after_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            outbox = Path(directory)
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: enqueue(outbox, "model:gpt-7.1-sol", "New model"), range(8)))
            files = list(outbox.glob("*.json"))
            self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text())["body"], "[info] codex-current: New model")
            (outbox / "sent").mkdir()
            files[0].rename(outbox / "sent" / files[0].name)
            enqueue(outbox, "model:gpt-7.1-sol", "New model")
            self.assertEqual(list(outbox.glob("*.json")), [])
            self.assertEqual(len(list((outbox / "sent").glob("*.json"))), 1)
            enqueue(outbox, "release:0.172.0", "Client behind")
            self.assertEqual(len(list(outbox.glob("*.json"))), 1)

    def test_failed_delivery_remains_visible_without_requeuing(self):
        with tempfile.TemporaryDirectory() as directory:
            outbox = Path(directory)
            enqueue(outbox, "model:gpt-7.1-sol", "New model")
            queued = next(outbox.glob("*.json"))
            (outbox / "failed").mkdir()
            queued.rename(outbox / "failed" / queued.name)
            with self.assertRaisesRegex(RuntimeError, "failed queue"):
                enqueue(outbox, "model:gpt-7.1-sol", "New model")
            self.assertEqual(list(outbox.glob("*.json")), [])
