import hashlib
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('sender', Path(__file__).parents[1] / 'sender.py')
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        sender.ROOT = Path(self.directory.name) / 'queue'

    def tearDown(self):
        self.directory.cleanup()

    def test_identical_retry_keeps_receipt_and_scrubs_delivered_body(self):
        payload = {'request_id': 'request-1', 'message': 'private location marker'}
        sender.enqueue(payload)
        with sender.database() as db:
            db.execute("UPDATE requests SET event_id='$delivered' WHERE id='request-1'")
        sender.enqueue(payload)
        with sender.database() as db:
            self.assertEqual(db.execute('SELECT id,body,event_id FROM requests').fetchall(),
                             [('request-1', '', '$delivered')])

    def test_conflicting_retry_is_rejected(self):
        sender.enqueue({'request_id': 'request-1', 'message': 'original'})
        with self.assertRaises(ValueError):
            sender.enqueue({'request_id': 'request-1', 'message': 'different'})
        with sender.database() as db:
            self.assertEqual(db.execute('SELECT body FROM requests').fetchall(), [('original',)])

    def test_oversized_unicode_message_does_not_block_next_request(self):
        with self.assertRaises(ValueError):
            sender.enqueue({'request_id': 'oversized', 'message': 'é' * 10000})
        sender.enqueue({'request_id': 'valid', 'message': 'call request'})
        with sender.database() as db:
            self.assertEqual(db.execute('SELECT id FROM requests').fetchall(), [('valid',)])

    def test_boundary_rejects_invalid_inputs(self):
        for payload in [[], {}, {'request_id': '../escape', 'message': 'x'},
                        {'request_id': 3, 'message': 'x'}, {'request_id': 'x', 'message': ''}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                sender.enqueue(payload)
        self.assertFalse(sender.ROOT.exists())

    def test_migrates_existing_delivered_rows_without_retaining_location(self):
        sender.ROOT.mkdir(parents=True)
        with sqlite3.connect(sender.ROOT / 'queue.sqlite3') as db:
            db.execute('CREATE TABLE requests (id TEXT PRIMARY KEY, body TEXT NOT NULL, event_id TEXT)')
            db.execute("INSERT INTO requests VALUES ('old','private location','$receipt')")
        with sender.database() as db:
            self.assertEqual(db.execute('SELECT body,body_hash FROM requests').fetchall(),
                             [('', hashlib.sha256(b'private location').hexdigest())])


if __name__ == '__main__':
    unittest.main()
