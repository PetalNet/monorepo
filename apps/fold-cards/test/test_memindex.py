"""python3 -I test/test_memindex.py: lexical qualification, candidate features from both rankers, note and vault sync,
no embedder."""
import json, os, sqlite3, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, '..', 'bin')
sys.path.insert(0, BIN)
sys.path.insert(0, HERE)
import memindex
from fake_embedder import FakeEmbedder


def index(d, docs):
    db = memindex.connect(os.path.join(d, 'cards.db'))
    for i in range(300):
        memindex.put(db, 'fold', f'filler{i}', '', f'what did you mention, it surfaces in the logs, item {i}')
    for src, id, body in docs:
        memindex.put(db, src, id, '2026-01-01', body)
    db.commit()
    return db


def rowid(db, id):
    return db.execute('SELECT rowid FROM doc WHERE id=?', (id,)).fetchone()[0]


class Candidates(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.db = index(self.d, [('fold', 'fg', 'check the old friendsgiving rsvp page, we need one for this year'),
                                 ('fold', 'potluck', 'dish signup slots for the dinner'),
                                 ('memory', 'memory:note.md', 'friendsgiving note kept in memory')])
        self.emb = FakeEmbedder(os.path.join(self.d, 'embed.sock'), [[rowid(self.db, 'potluck'), 0.83], [rowid(self.db, 'fg'), 0.81]])
        self.path = os.path.join(self.d, 'cards.db')

    def by_id(self, text, sources=('fold',), **kw):
        return {c['pointer']: c for c in memindex.candidates(self.path, text, list(sources), **kw)}

    def test_a_rare_term_carries_lexical_mass_and_common_terms_carry_none(self):
        got = self.by_id('so if i mention friendsgiving what surfaces')
        self.assertGreater(got['fg']['lex'], 0)
        self.assertEqual(got['filler1']['lex'], 0.0)

    def test_dense_hits_join_with_their_cosine_even_without_a_word_in_common(self):
        got = self.by_id('the thanksgiving potluck')
        self.assertEqual((got['potluck']['cos'], got['potluck']['dense_rank']), (0.83, 0))

    def test_sources_are_ranked_apart(self):
        self.assertNotIn('memory:note.md', self.by_id('friendsgiving'))
        self.assertIn('memory:note.md', self.by_id('friendsgiving', sources=('memory',)))

    def test_thread_reaches_the_dense_query_only_for_a_short_message(self):
        self.by_id('and that one?', thread=['the friendsgiving rsvp page'])
        self.by_id('what happened with the friendsgiving rsvp page and the dish signup slots last year', thread=['unrelated'])
        self.assertEqual([r['context'] for r in self.emb.requests], ['the friendsgiving rsvp page', ''])

    def test_rarity_is_counted_over_the_whole_index_not_per_source(self):
        memindex.put(self.db, 'memory', 'memory:logs.md', '', 'where the logs go when the disk fills')
        self.db.commit()
        got = self.by_id('which logs', sources=('memory',))
        self.assertEqual((got['memory:logs.md']['lex_rank'], got['memory:logs.md']['lex']), (0, 0.0))

    def test_allow_drops_documents_the_caller_may_not_see(self):
        got = self.by_id('friendsgiving', allow=lambda m: m[0] != 'fg')
        self.assertNotIn('fg', got)


class NoEmbedder(unittest.TestCase):
    def test_without_the_embedder_there_are_no_candidates_and_it_is_started_for_next_time(self):
        d = tempfile.mkdtemp()
        index(d, [('fold', 'fg', 'friendsgiving rsvp page')])
        os.makedirs(os.path.join(d, 'embed-venv', 'bin'))
        py = os.path.join(d, 'embed-venv', 'bin', 'python')
        with open(py, 'w') as f:
            f.write('#!/bin/sh\nexit 0\n')
        os.chmod(py, 0o700)
        self.assertIsNone(memindex.candidates(os.path.join(d, 'cards.db'), 'friendsgiving', ['fold']))
        self.assertTrue(os.path.exists(os.path.join(d, 'embed.starting')))


class Notes(unittest.TestCase):
    def test_sync_mirrors_edits_and_deletions(self):
        d = tempfile.mkdtemp()
        notes = os.path.join(d, 'notes')
        os.mkdir(notes)
        for name, text in (('a.md', 'the turkey goes in at noon'), ('b.md', 'parking is behind the gym')):
            with open(os.path.join(notes, name), 'w') as f:
                f.write(text)
        db = memindex.connect(os.path.join(d, 'cards.db'))
        self.assertEqual(memindex.sync_notes(db, notes), 2)
        self.assertEqual(memindex.sync_notes(db, notes), 0)
        with open(os.path.join(notes, 'a.md'), 'w') as f:
            f.write('the ham goes in at noon')
        os.remove(os.path.join(notes, 'b.md'))
        self.assertEqual(memindex.sync_notes(db, notes), 2)
        self.assertEqual(sorted(r[0] for r in db.execute("SELECT body FROM doc WHERE source='memory'")), ['the ham goes in at noon'])


def claim(id, text, status='active', freshness='fresh', sources=None):
    return dict(id=id, tier='shared', topic='t-shed', title='Shed', heading='Locks', text=text, status=status,
                source_type='PRIMARY', verdict='supported', freshness=freshness,
                sources=json.dumps([{'id': 's-1', 'title': 'Hardware receipt', 'rel': 'supports',
                                     'captured': '2026-11-02T10:00:00Z', 'freshness': freshness}] if sources is None else sources),
                created='2026-11-01T00:00:00Z', updated='2026-11-02T00:00:00Z')


def replica(path, claims):
    """Write a vault replica the way the vault engine does: a whole new file, renamed over the old one."""
    tmp = path + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript('''CREATE TABLE claim(id TEXT PRIMARY KEY, tier TEXT NOT NULL, topic TEXT NOT NULL, title TEXT NOT NULL,
        heading TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, source_type TEXT NOT NULL, verdict TEXT,
        freshness TEXT NOT NULL, sources TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);''')
    db.executemany('INSERT INTO claim VALUES (:id,:tier,:topic,:title,:heading,:text,:status,:source_type,:verdict,'
                   ':freshness,:sources,:created,:updated)', claims)
    db.execute("INSERT INTO meta VALUES ('built', '2026-11-02T00:00:00Z')")
    db.commit(); db.close()
    os.replace(tmp, path)


class Vault(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.db = memindex.connect(os.path.join(self.d, 'cards.db'))
        self.addCleanup(self.db.close)
        self.rep = os.path.join(self.d, 'index.sqlite')

    def claims(self):
        return {r[0]: json.loads(r[1]) for r in self.db.execute("SELECT id, meta FROM doc WHERE source='vault'")}

    def test_only_shared_tier_claims_are_mirrored(self):
        replica(self.rep, [claim('c-a', 'shared fact'), dict(claim('c-b', 'private fact'), tier='personal'),
                           dict(claim('c-c', 'agent note'), tier='agent')])
        memindex.sync_vault(self.db, self.rep)
        self.assertEqual(sorted(self.claims()), ['vault:c-a'])

    def test_vault_rows_shift_rarity_only_when_the_vault_is_searched(self):
        memindex.put(self.db, 'memory', 'memory:a', '', 'the server logs rotate weekly', {})
        memindex.put(self.db, 'memory', 'memory:b', '', 'the garden needs water', {})
        self.db.commit()
        before = memindex.rarity(self.db, ['logs'])
        replica(self.rep, [claim(f'c-{i}', f'The logs of shed {i} are kept.') for i in range(50)])
        memindex.sync_vault(self.db, self.rep)
        self.assertEqual(memindex.rarity(self.db, ['logs']), before)
        self.assertNotEqual(memindex.rarity(self.db, ['logs'], vault=True), before)

    def test_vault_rows_do_not_change_other_source_bm25_order_when_excluded(self):
        memindex.put(self.db, 'memory', 'memory:a', '', 'orchid orchid telescope')
        memindex.put(self.db, 'memory', 'memory:b', '', 'orchid compass compass compass')
        self.db.commit()
        terms = ['orchid', 'compass']
        before, _ = memindex.lexical(self.db, memindex.rarity(self.db, terms)[0], ['memory'])
        replica(self.rep, [claim(f'c-{i}', 'orchid compass compass') for i in range(70)])
        memindex.sync_vault(self.db, self.rep)
        after, _ = memindex.lexical(self.db, memindex.rarity(self.db, terms)[0], ['memory'])
        self.assertEqual(after, before)

    def test_existing_full_text_index_is_migrated_with_extra_search_text(self):
        memindex.put(self.db, 'memory', 'memory:a', '', 'common body', extra='syntheticneedle')
        self.db.commit()
        self.db.execute('DROP TABLE doc_fts_nonvault')
        self.db.commit()
        reopened = memindex.connect(os.path.join(self.d, 'cards.db'))
        rows = reopened.execute("SELECT rowid FROM doc_fts_nonvault WHERE doc_fts_nonvault MATCH 'syntheticneedle'").fetchall()
        self.assertEqual(len(rows), 1)
        reopened.close()

    def test_the_backing_source_is_a_source_or_supports_link(self):
        link = lambda id, rel: {'id': id, 'title': id.upper(), 'rel': rel, 'captured': '2026-11-02T10:00:00Z', 'freshness': 'fresh'}
        replica(self.rep, [claim('c-1', 'The shed padlock is a 4-digit Abus.', sources=[link('s-old', 'replaces'), link('s-no', 'contradicts'), link('s-yes', 'supports')]),
                           claim('c-2', 'The shed gets a shelf.', sources=[link('s-no', 'contradicts')])])
        memindex.sync_vault(self.db, self.rep)
        got = self.claims()
        self.assertEqual((got['vault:c-1']['source_id'], got['vault:c-1']['source_title']), ('s-yes', 'S-YES'))
        self.assertEqual((got['vault:c-2']['source_id'], got['vault:c-2']['source_title']), ('', ''))

    def test_sync_mirrors_active_claims_across_a_replaced_replica(self):
        replica(self.rep, [claim('c-1', 'The shed padlock is a 4-digit Abus.'), claim('c-2', 'The shed key is under the pot.'),
                           claim('c-3', 'The shed has no lock.', status='superseded')])
        self.assertEqual(memindex.sync_vault(self.db, self.rep), 2)
        self.assertEqual(sorted(self.claims()), ['vault:c-1', 'vault:c-2'])
        body, = self.db.execute("SELECT body FROM doc WHERE id='vault:c-1'").fetchone()
        self.assertEqual(body, 'Shed > Locks: The shed padlock is a 4-digit Abus.')
        replica(self.rep, [claim('c-1', 'The shed padlock is a 4-digit Abus.', freshness='stale'),
                           claim('c-2', 'The shed key is under the pot.', status='retracted'), claim('c-4', 'The shed gets a shelf.')])
        self.assertEqual(memindex.sync_vault(self.db, self.rep), 3)
        got = self.claims()
        self.assertEqual(sorted(got), ['vault:c-1', 'vault:c-4'])
        self.assertEqual({k: got['vault:c-1'][k] for k in ('claim', 'title', 'heading', 'source_type', 'freshness', 'source_id', 'source_title', 'captured')},
                         dict(claim='c-1', title='Shed', heading='Locks', source_type='PRIMARY', freshness='stale', source_id='s-1',
                              source_title='Hardware receipt', captured='2026-11-02T10:00:00Z'))
        self.assertEqual(memindex.sync_vault(self.db, self.rep), 0)

    def test_a_missing_or_unreadable_replica_removes_mirrored_claims_and_creates_nothing(self):
        replica(self.rep, [claim('c-1', 'The shed padlock is a 4-digit Abus.')])
        memindex.sync_vault(self.db, self.rep)
        os.remove(self.rep)
        self.assertIn('error', memindex.sync_vault(self.db, self.rep))
        self.assertFalse(os.path.exists(self.rep))
        with open(self.rep, 'w') as f:
            f.write('not a database')
        self.assertIn('error', memindex.sync_vault(self.db, self.rep))
        self.assertEqual(list(self.claims()), [])


if __name__ == '__main__':
    unittest.main()
