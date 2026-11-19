import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixtures import BIN, bundle_config, scanner_env


class Research(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = bundle_config(self.root)
        self.env = dict(scanner_env(), CONTEXT_BUNDLE_CONFIG=str(self.config), RESEARCH_PROJECT='demo',
                        RESEARCH_STATE_DIR=str(self.root / 'receipts'), FIXTURE_VAULT=str(self.root),
                        VAULT_RESEARCH_ARGV=json.dumps([sys.executable, str(Path(__file__).with_name('vault_fixture.py'))]))

    def cli(self, *args, payload=None):
        return subprocess.run([sys.executable, '-B', '-I', str(BIN / 'research.py'), *args],
                              input=json.dumps(payload) if payload is not None else None,
                              env=self.env, capture_output=True, text=True)

    def web(self, query):
        return self.cli('hook', payload={'session_id': 'synthetic', 'tool_name': 'WebSearch', 'tool_input': {'query': query}})

    def run_file(self, **changes):
        run = {'question': 'demo question', 'summary': 'A synthetic update.', 'topics': [{'title': 'Demo', 'summary': 'Demo'}],
               'claims': [{'key': 'new', 'topic': 'Demo', 'text': 'The updated fact.', 'heading': 'Findings', 'sourceType': 'PRIMARY',
                           'verdict': 'supported', 'replaces': 'c-12345678', 'links': [{'rel': 'source', 'to': 'src-87654321'}]}],
               'answer': ['new'], **changes}
        path = self.root / 'run.json'
        path.write_text(json.dumps(run))
        return str(path)

    def test_actual_check_process_precedes_web_and_stop_requires_writeback(self):
        output = self.web('demo question')
        hook = json.loads(output.stdout)['hookSpecificOutput']
        self.assertEqual(hook['permissionDecision'], 'allow', output.stderr)
        self.assertIn('lab_claims', hook['additionalContext'])
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual(calls, [['research-check', 'demo question']])
        self.assertEqual(json.loads(self.cli('stop', payload={'session_id': 'synthetic'}).stdout)['decision'], 'block')
        self.assertEqual(self.cli('finish', '--session', 'synthetic', '--run', self.run_file()).returncode, 0)
        self.assertEqual(json.loads((self.root / 'written.json').read_text())['claims'][0]['replaces'], 'c-12345678')
        self.assertEqual(self.cli('stop', payload={'session_id': 'synthetic'}).stdout, '')

    def test_refused_check_never_allows_web_or_prints_diagnostics(self):
        output = self.web('failure')
        self.assertEqual(json.loads(output.stdout)['hookSpecificOutput']['permissionDecision'], 'deny')
        self.assertNotIn('private diagnostic', output.stdout + output.stderr)

    def test_public_scope_does_not_query_the_private_vault(self):
        self.config.write_text(json.dumps({'projects': {'demo': {'source_scope': 'public-only',
                               'public_pointers': ['https://github.com/example/demo']}}}))
        output = self.web('demo question')
        self.assertEqual(json.loads(output.stdout)['hookSpecificOutput']['permissionDecision'], 'deny')
        self.assertFalse((self.root / 'calls.jsonl').exists())

    def test_many_sources_are_bounded_and_report_truncation(self):
        output = self.web('many sources')
        context = json.loads(output.stdout)['hookSpecificOutput']['additionalContext']
        provenance = json.loads(context.split('Lab research_check provenance:\n')[1].split('\nAfter researching')[0])
        self.assertEqual(len(provenance['lab_sources']), 24)
        self.assertTrue(provenance['truncated'])

    def test_writeback_cannot_skip_replaces_or_lose_pending_on_vault_failure(self):
        self.web('demo question')
        for file in (self.run_file(claims=[]),):
            self.assertEqual(self.cli('finish', '--session', 'synthetic', '--run', file).returncode, 2)
        self.assertEqual(self.cli('finish', '--session', 'synthetic', '--run', self.run_file(summary='reject')).returncode, 2)
        self.assertEqual(json.loads(self.cli('stop', payload={'session_id': 'synthetic'}).stdout)['decision'], 'block')
        unresolved = self.run_file(claims=[], answer=[], gaps=[{'ref': 'c-12345678', 'reason': 'Source unavailable.'}])
        self.assertEqual(self.cli('finish', '--session', 'synthetic', '--run', unresolved).returncode, 0)

    def test_no_check_in_another_session_and_no_effect_on_non_search_tools(self):
        self.assertEqual(self.cli('finish', '--session', 'another', '--run', self.run_file()).returncode, 2)
        self.assertEqual(self.cli('hook', payload={'tool_name': 'Read'}).stdout, '')


if __name__ == '__main__':
    unittest.main()
