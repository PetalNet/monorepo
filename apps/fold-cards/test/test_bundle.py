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
        self.assertEqual(payload['documents'][0]['pointer'], 'vault:shared/source/doc-00000001#^p-demo')
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

    def test_public_scope_never_opens_private_indexes_and_still_scans(self):
        config = {'projects': {'public-demo': {'source_scope': 'public-only',
                  'public_pointers': ['https://github.com/example/demo']}}}
        self.config.write_text(json.dumps(config))
        brief = 'Project: public-demo\nReview the public code.'
        result = self.run_bundle(brief)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('https://github.com/example/demo', result.stdout)
        self.assertNotIn('event:$event', result.stdout)
        self.assertEqual(self.run_bundle(brief + '\nfixture-secret').stdout, '')
        config['projects']['public-demo']['public_pointers'] = ['file:///private/history']
        self.config.write_text(json.dumps(config))
        self.assertEqual(self.run_bundle(brief).stdout, '')

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

    def test_open_respects_active_topics_and_fold_sources(self):
        import sqlite3
        def opened(pointer):
            return subprocess.run([sys.executable, '-B', '-I', str(BIN / 'bundle.py'), '--open', pointer,
                                   '--project', 'demo'], env=self.env, capture_output=True, text=True)
        with closing(sqlite3.connect(Path(self.temp.name) / 'vault.db')) as db, db:
            db.execute("INSERT INTO claim SELECT 'c-other', tier, 't-other', title, heading, text, status, source_type, verdict, freshness, sources, created, updated FROM claim WHERE id='c-00000002'")
        for pointer in ('vault:personal/claim/c-other', 'vault:personal/claim/c-00000001'):
            result = opened(pointer)
            self.assertEqual((result.returncode, result.stdout), (2, ''))
        self.assertEqual(opened('vault:personal/claim/c-00000002').returncode, 0)
        transcript = Path(self.temp.name) / 'card.jsonl'
        transcript.write_text('Synthetic card content')
        with closing(sqlite3.connect(Path(self.temp.name) / 'fold.db')) as db, db:
            db.execute('INSERT INTO card VALUES(?,?,?,?,?,?,?,?,?)', ('session1:uuid2', 'session1', str(transcript),
                       0, transcript.stat().st_size, '2026-11-01', 'assistant', '', 'Synthetic card content'))
        self.assertEqual(opened('session1:uuid2').returncode, 0)
        config = json.loads(self.config.read_text())
        config['projects']['demo']['fold_sources'] = []
        self.config.write_text(json.dumps(config))
        result = opened('session1:uuid2')
        self.assertEqual((result.returncode, result.stdout), (2, ''))

    def test_open_sources_requires_topic_link_or_project_query(self):
        import sqlite3
        with closing(sqlite3.connect(Path(self.temp.name) / 'vault.db')) as db, db:
            for id, text, freshness in [('unrelated', 'Unrelated text', 'fresh'),
                                        ('matching', 'Demo project evidence', 'fresh'),
                                        ('retired', 'Demo project obsolete evidence', 'retracted')]:
                db.execute('INSERT INTO passage VALUES(?,?,?,?,?,?,?,?)',
                           (id, 'p', 'shared', 'memory', 'Source', '', text, freshness))
                db.execute('INSERT INTO passage_fts VALUES(?,?,?,?)', (id, 'p', text, ''))
        for id, code in [('doc-00000001', 0), ('matching', 0), ('unrelated', 2), ('retired', 2)]:
            result = subprocess.run([sys.executable, '-B', '-I', str(BIN / 'bundle.py'), '--open',
                                     'vault:shared/source/' + id, '--project', 'demo'],
                                    env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, code, result.stderr)
            if code:
                self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
