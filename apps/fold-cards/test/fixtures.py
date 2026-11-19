"""Synthetic databases using the producers' schemas; no live history is opened."""
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import sys

BIN = Path(__file__).resolve().parent.parent / 'bin'
sys.path.insert(0, str(BIN))
import cards
import memindex


def scanner_env():
    return dict(os.environ, FOLD_SECRET_SCANNER_ARGV=json.dumps([sys.executable, str(Path(__file__).with_name('scanner.py'))]))


def bundle_config(directory):
    root = Path(directory)
    paths = {name + '_db': str(root / (name + '.db')) for name in ('vault', 'history', 'recall', 'agentsview', 'fold')}
    with closing(sqlite3.connect(paths['vault_db'])) as db, db:
        db.executescript('''CREATE TABLE claim(id TEXT, tier TEXT, topic TEXT, title TEXT, heading TEXT, text TEXT,
            status TEXT, source_type TEXT, verdict TEXT, freshness TEXT, sources TEXT, created TEXT, updated TEXT);
            CREATE TABLE passage(source TEXT, passage TEXT, tier TEXT, kind TEXT, title TEXT, heading TEXT, text TEXT, freshness TEXT);
            CREATE VIRTUAL TABLE passage_fts USING fts5(source UNINDEXED, passage UNINDEXED, text, context);''')
        for id, status, date in [('c-00000001', 'superseded', '2026-01-01'), ('c-00000002', 'active', '2026-11-01')]:
            db.execute('INSERT INTO claim VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', (id, 'personal', 't-demo', 'Demo', 'Decision',
                       'Never emit this decision text', status, 'DIRECT', None, 'fresh',
                       json.dumps([{'id': 'doc-00000001', 'freshness': 'fresh', 'passage': 'p-demo'}]), date, date))
    with closing(sqlite3.connect(paths['history_db'])) as db, db:
        db.executescript('''CREATE TABLE entry(id INTEGER PRIMARY KEY, ts REAL, surface TEXT, channel TEXT, branch TEXT,
            session TEXT, direction TEXT, sender TEXT, text TEXT, audience TEXT, ref TEXT);
            CREATE VIRTUAL TABLE entry_fts USING fts5(text, surface, channel, branch, content='entry', content_rowid='id');''')
        for id, direction in [(1, 'in'), (2, 'out')]:
            text = 'Demo project discussion https://github.com/example/demo/pull/12#discussion_r34'
            db.execute('INSERT INTO entry VALUES(?,?,?,?,?,?,?,?,?,?,?)', (id, 1.0 + id, 'matrix', '!demo', 'main', 's1', direction, 'fixture', text, '', f'$event{id}'))
            db.execute('INSERT INTO entry_fts(rowid,text,surface,channel,branch) VALUES(?,?,?,?,?)', (id, text, 'matrix', '!demo', 'main'))
    with closing(sqlite3.connect(paths['recall_db'])) as db, db:
        db.execute("CREATE VIRTUAL TABLE messages USING fts5(text,role UNINDEXED,session UNINDEXED,ts UNINDEXED,uuid UNINDEXED,file UNINDEXED)")
        db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?)', ('Demo project assistant answer', 'assistant', 's1', '2026-11-01', 'uuid1', '/unused'))
    with closing(sqlite3.connect(paths['agentsview_db'])) as db, db:
        db.executescript('''CREATE TABLE sessions(id TEXT PRIMARY KEY, agent TEXT, project TEXT, cwd TEXT, file_path TEXT, deleted_at TEXT);
            CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, timestamp TEXT, ordinal INTEGER, role TEXT, dialogue_text TEXT, content TEXT);
            CREATE VIRTUAL TABLE messages_fts USING fts5(content);''')
        db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)', ('session1', 'codex', 'demo', '/unused', '/unused', None))
        db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?)', (1, 'session1', '2026-11-01', 7, 'assistant', 'Demo project answer', 'Demo project answer'))
        db.execute('INSERT INTO messages_fts(rowid,content) VALUES(?,?)', (1, 'Demo project answer'))
    db = cards.connect(paths['fold_db'])
    memindex.put(db, 'fold', 'session1:uuid2', '2026-11-01', 'Demo project folded answer', {'event_id': '$fold'})
    db.commit()
    db.close()
    config = {**paths, 'projects': {'demo': {'query': 'Demo project', 'vault_topics': ['t-demo'],
              'history_channels': ['!demo'], 'agentsview_projects': ['demo'], 'fold_sources': ['fold']}}}
    file = root / 'bundles.json'
    file.write_text(json.dumps(config))
    return file
