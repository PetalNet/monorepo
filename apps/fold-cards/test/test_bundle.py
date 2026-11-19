import json
from contextlib import closing
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixtures import BIN, bundle_config, scanner_env


class Bundle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = bundle_config(self.temp.name)
        self.env = dict(scanner_env(), CONTEXT_BUNDLE_CONFIG=str(self.config))

    def run_bundle(self, brief='Project: demo\nGoal: investigate current constraints.', env=None):
        return subprocess.run([sys.executable, '-B', '-I', str(BIN / 'bundle.py')], input=brief,
                              env=self.env if env is None else env, capture_output=True, text=True)

    def test_existing_indexes_produce_pointers_for_every_source(self):
        result = self.run_bundle()
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.split('newest first):\n')[1])
        self.assertEqual([d['pointer'] for d in payload['decisions']], ['vault:personal/claim/c-00000002'])
        self.assertTrue(payload['documents'])
        self.assertEqual([x['start'] for x in payload['conversations']], ['event:$event2', 'event:$event1', 'transcript:s1:uuid1'])
        self.assertEqual(payload['agent_sessions'][0]['pointer'], 'agentsview:session/session1?msg=7')
        self.assertEqual(payload['fold_cards'][0]['pointer'], 'session1:uuid2')
        self.assertIn('#discussion_r34', payload['pull_requests'][0])
        self.assertNotIn('Never emit', result.stdout)
        self.assertNotIn('folded answer', result.stdout)

    def test_missing_project_or_index_and_secret_never_release_brief(self):
        for brief in ('Goal: investigate.', 'Project: unknown\nGoal: investigate.', 'Project: demo\nfixture-secret'):
            result = self.run_bundle(brief)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, '')
            self.assertNotIn('fixture-secret', result.stderr)
        (Path(self.temp.name) / 'history.db').unlink()
        self.assertEqual(self.run_bundle().stdout, '')

    def test_unconfigured_scanner_refuses(self):
        env = self.env.copy()
        env.pop('FOLD_SECRET_SCANNER_ARGV')
        self.assertEqual(self.run_bundle(env=env).stdout, '')

    def test_pointers_resolve_through_the_same_guard(self):
        for pointer, content in [('vault:personal/claim/c-00000002', 'Never emit this decision text'),
                                 ('event:$event2', 'Demo project discussion'),
                                 ('transcript:s1:uuid1', 'Demo project assistant answer'),
                                 ('agentsview:session/session1?msg=7', 'Demo project answer')]:
            result = subprocess.run([sys.executable, '-B', '-I', str(BIN / 'bundle.py'), '--open', pointer,
                                     '--project', 'demo'], env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(content, json.loads(result.stdout)['text'])
        import sqlite3
        with closing(sqlite3.connect(Path(self.temp.name) / 'history.db')) as db, db:
            db.execute("UPDATE entry SET text='fixture-secret' WHERE id=2")
        result = subprocess.run([sys.executable, '-B', '-I', str(BIN / 'bundle.py'), '--open', 'event:$event2',
                                 '--project', 'demo'], env=self.env, capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout), (2, ''))

    def test_agent_hook_updates_prompt_and_preserves_options(self):
        hook = BIN.parents[2] / 'packages/harness-hooks/src/agent-brief-guard.ts'
        for extra in ({}, {'agent_id': 'nested'}):
            payload = {'tool_name': 'Agent', 'tool_input': {'prompt': 'Project: demo\nGoal: investigate.',
                       'subagent_type': 'planner', 'description': 'synthetic'}, **extra}
            result = subprocess.run(['node', '--no-warnings', str(hook)], input=json.dumps(payload),
                                    env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)['hookSpecificOutput']
            self.assertEqual(output['permissionDecision'], 'allow')
            self.assertIn('event:$event2', output['updatedInput']['prompt'])
            self.assertEqual(output['updatedInput']['description'], 'synthetic')
            payload['tool_input']['prompt'] = 'Goal: no project'
            denied = subprocess.run(['node', '--no-warnings', str(hook)], input=json.dumps(payload),
                                    env=self.env, capture_output=True, text=True)
            self.assertEqual(json.loads(denied.stdout)['hookSpecificOutput']['permissionDecision'], 'deny')


if __name__ == '__main__':
    unittest.main()
