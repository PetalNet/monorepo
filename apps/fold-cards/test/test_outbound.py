import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixtures import BIN, scanner_env
import outbound
import test_cards


class Guard(unittest.TestCase):
    def test_protocol_errors_hits_and_timeout_release_nothing(self):
        commands = [None, 'broken json', '[]', json.dumps(['/no/such/scanner']),
                    json.dumps([sys.executable, '-c', "print('unexpected')"]),
                    json.dumps([sys.executable, '-c', "import sys; sys.stderr.write('unexpected')"]),
                    json.dumps([sys.executable, '-c', 'raise SystemExit(1)']),
                    json.dumps([sys.executable, '-c', 'import time; time.sleep(5)'])]
        for command in commands:
            env = {} if command is None else {'FOLD_SECRET_SCANNER_ARGV': command}
            output = io.StringIO()
            with patch.dict(os.environ, env, clear=True), patch.object(outbound, 'TIMEOUT', 0.1), contextlib.redirect_stdout(output):
                with self.assertRaises(outbound.Refused):
                    outbound.emit('fixture-secret')
            self.assertEqual(output.getvalue(), '')
        with patch.dict(os.environ, scanner_env()):
            with self.assertRaises(outbound.Refused):
                outbound.emit('safe excerpt', ['fixture-secret beyond excerpt'])

    def test_allowed_text_is_unchanged(self):
        output = io.StringIO()
        with patch.dict(os.environ, scanner_env()), contextlib.redirect_stdout(output):
            outbound.emit('synthetic harmless text')
        self.assertEqual(output.getvalue(), 'synthetic harmless text\n')


class RetrievalGuard(unittest.TestCase):
    setUp = test_cards.Cards.setUp
    embed = test_cards.Cards.embed

    def test_ledger_export_refuses_before_creating_a_file(self):
        with open(self.t, 'r+') as f:
            text = f.read().replace('under the blue pot.', 'under the blue pot. fixture-secret')
            f.seek(0)
            f.write(text)
            f.truncate()
        ledger = Path(self.d) / 'ledger.jsonl'
        result = subprocess.run([sys.executable, '-I', str(BIN / 'cards.py'), 'build', '--db', self.db,
                                 '--session', '00000000-0000-4000-8000-000000000001', '--transcript', self.t,
                                 '--ledger-cards', str(ledger)], env=scanner_env(), capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout), (2, ''))
        self.assertFalse(ledger.exists())
    # Exercise the actual three retrieval processes with a secret beyond the printed excerpt.
    def test_all_retrieval_channels_are_atomic(self):
        with open(self.t, 'r+') as f:
            text = f.read().replace('under the blue pot.', 'under the blue pot. ' + 'x' * 500 + ' fixture-secret')
            f.seek(0)
            f.write(text)
            f.truncate()
        test_cards.run('build', '--db', self.db, '--session', '00000000-0000-4000-8000-000000000001', '--transcript', self.t)
        self.embed(('00000000-0000-4000-8000-000000000001:u0001', 0.99))
        commands = [
            [str(BIN / 'cards.py'), 'query', '--text', 'where is the spare key for shed 7?', '--thread', '[]'],
            [str(BIN / 'cards.py'), 'unfold', '00000000-0000-4000-8000-000000000001:u0001', '--max-tool-chars', '40'],
            [str(BIN / 'memindex.py'), 'search', '--text', 'where is the spare key for shed 7?'],
        ]
        for command in commands:
            result = subprocess.run([sys.executable, '-I', *command, '--db', self.db], env=scanner_env(), capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(result.stdout, '')
            self.assertNotIn('fixture-secret', result.stderr)


if __name__ == '__main__':
    unittest.main()
