import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'apps/fold-cards/test'))
from fixtures import bundle_config, scanner_env


class RouterBundleCLI(unittest.TestCase):
    def test_private_bundle_is_guarded_before_adapter_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = bundle_config(temp)
            (root / '.claude/shared').mkdir(parents=True)
            (root / '.claude/shared/model-tiers.json').write_text(json.dumps({
                'tiers': {'C': 0}, 'models': [
                    {'id': 'gemini-first-high', 'provider': 'gemini', 'score': 40},
                    {'id': 'gpt-test', 'provider': 'codex', 'score': 38}]}))
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            codex = bin_dir / 'codex'
            codex.write_text('#!/bin/sh\ncat > "$HOME/adapter-prompt"\nprintf "ok\\n"\n')
            codex.chmod(0o755)
            reader = bin_dir / 'reader'
            reader.write_text('#!/bin/sh\nprintf "Logged in using ChatGPT\\n"\n')
            reader.chmod(0o755)
            inject = root / '.hermes/plugins/hermes-cc-link/bin/cc-link-inject'
            inject.parent.mkdir(parents=True)
            inject.write_text('#!/bin/sh\ncat >/dev/null\n')
            inject.chmod(0o755)
            brief = root / 'brief.txt'
            brief.write_text('Project: demo\nGoal: investigate the synthetic project.\n')
            env = dict(scanner_env(), HOME=temp, CONTEXT_BUNDLE_CONFIG=str(config),
                       PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                       QUOTA_AGY_CMD=str(reader), QUOTA_CODEX_CMD=str(reader),
                       QUOTA_CLAUDE_USAGE_CMD=str(reader), QUOTA_CODEX_SESSIONS_DIR=str(root / 'no-sessions'))
            shared_scanner = os.environ.get('ROUTER_TEST_SHARED_SCANNER')
            if shared_scanner:
                provider = root / 'provider.py'
                provider.write_text('import json\nprint(json.dumps({"fixture": "fixture-secret"}))\n')
                env['FOLD_SECRET_SCANNER_ARGV'] = json.dumps(['node', shared_scanner])
                env['VAULT_SECRET_PROVIDER_ARGV'] = json.dumps([sys.executable, str(provider)])
            argv = ['node', '--no-warnings', str(ROOT / 'packages/router/src/route.ts'), 'run',
                    '--kind', 'sweep', '--tier', 'C', '--data-class', 'public', str(brief)]
            with sqlite3.connect(root / 'history.db') as db:
                db.execute("UPDATE entry SET text='Demo project fixture-secret' WHERE id=2")
            refused = subprocess.run(argv, env=env, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(refused.returncode, 0)
            self.assertFalse((root / 'adapter-prompt').exists())
            self.assertNotIn('fixture-secret', refused.stdout + refused.stderr)
            with sqlite3.connect(root / 'history.db') as db:
                db.execute("UPDATE entry SET text='Demo project clean text' WHERE id=2")
            clean = subprocess.run(argv, env=env, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(clean.returncode, 0, clean.stderr + clean.stdout)
            prompt = (root / 'adapter-prompt').read_text()
            self.assertIn('Project: demo', prompt)
            self.assertIn('event:$event2', prompt)
            self.assertNotIn('Demo project clean text', prompt)
            self.assertNotIn('Never emit this decision text', prompt)
            self.assertNotEqual(prompt.strip(), str(brief))
            (root / 'adapter-prompt').unlink()
            excluded = subprocess.run(argv[:-1] + ['--not-vendor', 'openai', str(brief)],
                                      env=env, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(excluded.returncode, 3, excluded.stderr + excluded.stdout)
            self.assertFalse((root / 'adapter-prompt').exists())
            brief.write_text('Project: demo\nPARCS fixture-secret\n')
            parcs = subprocess.run(argv, env=env, cwd=root, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(parcs.returncode, 5)
            self.assertNotIn('fixture-secret', parcs.stdout + parcs.stderr)
            self.assertFalse((root / 'adapter-prompt').exists())


if __name__ == '__main__':
    unittest.main()
