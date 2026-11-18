"""python3 -I test/test_cards.py: cards.py build/query/unfold over a synthetic transcript."""
import json, os, subprocess, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_embedder import FakeEmbedder
from test_memindex import memindex, claim, replica

CARDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin', 'cards.py')
S = '00000000-0000-4000-8000-000000000001'


def row(i, typ, content, **kw):
    r = {'type': typ, 'uuid': f'u{i:04d}', 'sessionId': S, 'timestamp': f'2026-01-01T00:00:{i:02d}Z',
         'message': {'role': typ, 'content': content}}
    r.update(kw)
    return r


def chan(ev, who, text):
    return f'<channel source="chat" sender="{who}" sender_id="@{who}:example.org" event_id="{ev}">\n[{who}]: {text}\n</channel>'


ROWS = [
    row(1, 'user', 'Note: the spare key for shed 7 is under the blue pot.'),
    row(2, 'assistant', [{'type': 'text', 'text': 'noted'}]),
    row(3, 'user', chan('$evt0003', 'alice', 'Deploy only from main.'), isMeta=True, origin={'kind': 'channel'}),
    row(4, 'assistant', [{'type': 'tool_use', 'id': 't1', 'name': 'Bash', 'input': {'command': 'git log -1'}}]),
    row(5, 'user', [{'type': 'tool_result', 'tool_use_id': 't1', 'content': 'commit 3f9a2c1d0e'}]),
    row(6, 'assistant', [{'type': 'text', 'text': 'ok, head is 3f9a2c1d0e'}]),
    {'type': 'attachment', 'uuid': 'u0007', 'sessionId': S, 'timestamp': '2026-01-01T00:00:07Z',
     'attachment': {'type': 'queued_command', 'prompt': chan('$evt0007', 'bob', 'Ship it Friday.')}},
    row(8, 'assistant', [{'type': 'text', 'text': 'will do'}]),
    row(9, 'user', 'still open stretch'),
]


def run(*args):
    return subprocess.run([sys.executable, '-I', CARDS, *args], capture_output=True, text=True, check=True).stdout


class Cards(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.t = os.path.join(self.d, S + '.jsonl')
        with open(self.t, 'w') as f:
            f.writelines(json.dumps(r) + '\n' for r in ROWS)
        self.db = os.path.join(self.d, 'cards.db')

    def test_build_is_idempotent_and_skips_the_open_stretch(self):
        first = json.loads(run('build', '--db', self.db, '--session', S, '--transcript', self.t, '--ledger-cards', self.d + '/c.jsonl'))
        again = json.loads(run('build', '--db', self.db, '--session', S, '--transcript', self.t))
        self.assertEqual((first['added'], again['added']), (3, 0))
        with open(self.d + "/c.jsonl") as f:
            cards = [json.loads(l) for l in f]
        self.assertEqual([c['who'] for c in cards], ['user', '@alice:example.org', '@bob:example.org'])

    def embed(self, *hits):
        """Serve the given (id, cosine) pairs as the embedder's answer to every query, inside the crowd of 19 middling
        documents per source that a real query also gets, since the gate judges a candidate against its field."""
        db = memindex.connect(self.db)
        rowid = lambda id: db.execute('SELECT rowid FROM doc WHERE id=?', (id,)).fetchone()[0]
        crowd = []
        for src in {db.execute('SELECT source FROM doc WHERE id=?', (id,)).fetchone()[0] for id, _ in hits} | {'fold'}:
            for i in range(19):
                memindex.put(db, src, f'{src}:crowd{i}', '', f'unrelated filler {i}', {'path': f'/crowd/{src}{i}.md'})
                crowd.append([rowid(f'{src}:crowd{i}'), 0.70 + (i % 5) / 500])
        db.commit()
        return FakeEmbedder(os.path.join(self.d, 'embed.sock'), [[rowid(id), cos] for id, cos in hits] + crowd)

    def query(self, text, *args):
        return json.loads(run('query', '--db', self.db, '--thread', '[]', *args, '--text', text))

    def test_query_attaches_a_close_card_and_unfold_returns_the_exact_source(self):
        run('build', '--db', self.db, '--session', S, '--transcript', self.t)
        self.embed((f'{S}:u0001', 0.9), (f'{S}:u0003', 0.6))
        hits = self.query('where is the spare key for shed 7?')
        self.assertEqual([h['pointer'] for h in hits], [f'{S}:u0001'])
        out = run('unfold', hits[0]['pointer'], '--db', self.db)
        self.assertIn('the spare key for shed 7 is under the blue pot.', out)
        self.assertNotIn('Deploy only from main', out)
        self.assertIn('Ship it Friday.', run('unfold', 'event:$evt0007', '--db', self.db))

    def test_nothing_attaches_without_the_embedder_or_below_the_floor(self):
        run('build', '--db', self.db, '--session', S, '--transcript', self.t)
        self.assertEqual(self.query('where is the spare key for shed 7?'), [])
        self.embed((f'{S}:u0001', 0.5))
        self.assertEqual(self.query('where is the spare key for shed 7?'), [])

    def test_the_channel_wrapper_is_not_part_of_the_query(self):
        run('build', '--db', self.db, '--session', S, '--transcript', self.t)
        emb = self.embed((f'{S}:u0003', 0.9))
        wrapped = ('<channel source="hermes-link" sender="bob" sender_id="@bob:example.org" room_id="!r:example.org" event_id="$x">\n'
                   '[!r:example.org - Lab] [bob]: do we deploy from main?\n</channel>\n\nIMPORTANT: This is NOT from your user')
        self.assertEqual([h['pointer'] for h in self.query(wrapped, '--sources', 'fold')], [f'{S}:u0003'])
        self.assertEqual(emb.requests[-1]['text'], 'do we deploy from main?')
        self.assertEqual(self.query('<task-notification>\n<status>completed</status>\n</task-notification>'), [])
        self.assertEqual(len(emb.requests), 1, 'a harness notice is not searched at all')

    def test_build_mirrors_note_and_doc_dirs_and_query_names_what_it_attaches(self):
        notes, docs = os.path.join(self.d, 'notes'), os.path.join(self.d, 'docs')
        os.mkdir(notes); os.mkdir(docs)
        with open(os.path.join(notes, 'shed.md'), 'w') as f:
            f.write('---\nname: shed-code\ndescription: "The shed padlock code lives here"\n---\n\nThe shed padlock code is 4471.')
        with open(os.path.join(notes, 'MEMORY.md'), 'w') as f:
            f.write('- [Shed](shed.md) padlock code')
        with open(os.path.join(docs, 'garden.md'), 'w') as f:
            f.write('# Garden plan\n\n## Shed\n\n' + 'The shed gets a new padlock and a shelf for the seed trays in spring. ' * 3)
        with open(os.path.join(self.d, 'config.json'), 'w') as f:
            json.dump({'index': {'notes': {'memory': notes}, 'docs': {'shared': docs}}}, f)
        out = json.loads(run('build', '--db', self.db, '--session', S, '--transcript', self.t))
        self.assertEqual(out['notes'], {'memory': 2, 'shared': 1})
        self.embed(('memory:MEMORY.md', 0.96), ('memory:shed.md', 0.95), ('shared:garden.md#0', 0.95))
        got = [(h['pointer'], h['name'], h['description'], h['path']) for h in self.query('shed padlock code') if h['source'] != 'fold']
        # MEMORY.md is already in context, and documents have no fitted model yet, so neither attaches
        self.assertEqual(got, [('memory:shed.md', 'shed-code', 'The shed padlock code lives here', os.path.join(notes, 'shed.md'))])
        self.assertEqual(self.query('shed padlock code', '--sources', 'fold'), [])
        doc = json.loads(subprocess.run([sys.executable, '-I', os.path.join(os.path.dirname(CARDS), 'memindex.py'), 'search', '--db', self.db,
                                         '--sources', 'shared', '--text', 'shed padlock'], capture_output=True, text=True, check=True).stdout.splitlines()[0])
        self.assertEqual((doc['pointer'], doc['kept']), ('shared:garden.md#0', False))

    def flag(self, on):
        with open(os.path.join(self.d, 'config.json'), 'w') as f:
            json.dump({'index': {'vault': os.path.join(self.d, 'index.sqlite')}, 'recall': {'vault': on}}, f)

    def vault(self, on, claims):
        replica(os.path.join(self.d, 'index.sqlite'), claims)
        self.flag(on)
        return json.loads(run('build', '--db', self.db, '--session', S, '--transcript', self.t))

    def test_vault_claims_are_searched_and_attached_only_with_the_flag_on(self):
        out = self.vault(False, [claim('c-1', 'The shed padlock is a 4-digit Abus.')])
        self.assertEqual(out['notes'], {'vault': 1}, 'index.vault alone still indexes the claims')
        emb = self.embed(('vault:c-1', 0.95))
        for args in ((), ('--sources', 'fold,vault')):
            self.assertEqual(self.query('which padlock is on the shed?', *args), [])
            self.assertNotIn('vault', emb.requests[-1]['sources'], 'with the flag off the vault is not searched at all')
        self.flag(True)
        self.assertEqual([h['pointer'] for h in self.query('which padlock is on the shed?')], ['vault:c-1'])
        self.assertIn('vault', emb.requests[-1]['sources'])

    def test_a_claim_card_carries_its_source_and_freshness(self):
        self.vault(True, [claim('c-1', 'The shed padlock is a 4-digit Abus.', freshness='stale'),
                          claim('c-2', 'The shed gets a shelf in spring.', sources=[])])
        emb = self.embed(('vault:c-1', 0.95), ('vault:c-2', 0.66))
        hit, = self.query('which padlock is on the shed?')
        self.assertEqual(hit['card'], '[claim c-1] Shed > Locks: The shed padlock is a 4-digit Abus. '
                                      '(PRIMARY; source: Hardware receipt, captured 2026-11-02, stale)')
        emb.hits = [[r, {0.95: 0.66, 0.66: 0.95}.get(cos, cos)] for r, cos in emb.hits]
        hit, = self.query('when does the shed get a shelf?')
        self.assertEqual(hit['card'], '[claim c-2] Shed > Locks: The shed gets a shelf in spring. (PRIMARY; fresh)')

    def test_without_a_thread_argument_the_room_thread_is_kept_between_prompts(self):
        run('build', '--db', self.db, '--session', S, '--transcript', self.t)
        self.embed()
        msg = lambda t: ('<channel source="hermes-link" sender="bob" room_id="!r:example.org">\n[!r:example.org - Lab] [bob]: '
                         + t + '\n</channel>')
        for t in ('first', 'second', 'third'):
            run('query', '--db', self.db, '--text', msg(t))
        with open(os.path.join(self.d, 'recall-thread.json')) as f:
            self.assertEqual([t for _, t in json.load(f)['!r:example.org']], ['second', 'third'])


if __name__ == '__main__':
    unittest.main()
