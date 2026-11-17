"""python3 -I test/test_memindex.py: lexical qualification, candidate features from both rankers, note sync, no embedder."""
import os, sys, tempfile, unittest

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


if __name__ == '__main__':
    unittest.main()
