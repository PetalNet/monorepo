#!/usr/bin/env python3
"""Snippet cards over Claude Code transcripts, kept in an SQLite FTS5 index.

  cards.py build  --db DB --session ID [--transcript PATH] [--ledger-cards FILE]
  cards.py query  --db DB --text TEXT [--k 4] [--exclude PTR,PTR] [--sources fold,memory] [--thread JSON]
  cards.py unfold POINTER [--db DB] [--max-tool-chars N]

A card is one finished stretch: a person's prompt and everything up to the next prompt.
Its pointer is <session>:<uuid of the prompt row>; `event:<channel event_id>` also resolves.
build is idempotent: it resumes from the byte offset it stopped at and skips known pointers.
Cards are one source in the shared recall index (memindex.py), which also does the searching.
"""
import argparse, glob, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script directory off sys.path
import memindex

CHANNEL = re.compile(r'<channel source="[^"]*"([^>]*)>([\s\S]*?)</channel>')
ATTR = lambda s, k: (re.search(k + r'="([^"]*)"', s) or [None, ''])[1]
ANCHOR = re.compile(r'https://github\.com/[\w.-]+/[\w.-]+/(?:pull|issues)/\d+|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b'
                    r'|(?:~|/home|/etc|/nix|/var|/tmp|/srv|/run)(?:/[\w.@+-]+)+|\$[A-Za-z0-9_-]{30,}')


def connect(path):
    db = memindex.connect(path)
    db.executescript('''
      CREATE TABLE IF NOT EXISTS card(pointer TEXT PRIMARY KEY, session TEXT, transcript TEXT, start INTEGER, end INTEGER,
        ts TEXT, who TEXT, event_id TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS progress(transcript TEXT PRIMARY KEY, offset INTEGER);''')
    return db


def index_card(db, c):
    memindex.put(db, 'fold', c['pointer'], c['ts'], c['body'], {'who': c['who'], 'event_id': c['event_id']}, c['event_id'])


def migrate(db):
    """Cards written before the shared index existed. Runs once; afterwards the counts match."""
    if db.execute("SELECT count(*) FROM doc WHERE source='fold'").fetchone()[0] < db.execute('SELECT count(*) FROM card').fetchone()[0]:
        for r in db.execute('SELECT pointer, ts, who, event_id, body FROM card WHERE pointer NOT IN (SELECT id FROM doc)').fetchall():
            index_card(db, dict(zip(('pointer', 'ts', 'who', 'event_id', 'body'), r)))
        db.commit()


def find_transcript(session):
    roots = [os.environ.get('CLAUDE_CONFIG_DIR') or '', os.path.expanduser('~/.claude')]
    for r in roots:
        for p in glob.glob(os.path.join(r, 'projects', '*', session + '.jsonl')) if r else []:
            return p
    return None


def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if b.get('type') == 'text':
            out.append(b.get('text', ''))
        elif b.get('type') == 'tool_result':
            c = b.get('content')
            out.append(text_of(c) if isinstance(c, list) else str(c or ''))
        elif b.get('type') == 'tool_use':
            out.append(b.get('name', '') + ' ' + json.dumps(b.get('input', {}))[:2000])
    return '\n'.join(out)


def prompt_text(row):
    """The text of a row that opens a stretch: a person's prompt, a channel message (stored as a meta
    user row, or as a queued_command attachment when it arrived mid-turn). None for anything else."""
    if row.get('type') == 'attachment':
        att = row.get('attachment') or {}
        t = att.get('prompt') if att.get('type') == 'queued_command' else None
        return t if isinstance(t, str) and CHANNEL.search(t) else None
    if row.get('type') != 'user' or row.get('isCompactSummary') or row.get('isSidechain'):
        return None
    if row.get('isMeta') and (row.get('origin') or {}).get('kind') != 'channel':
        return None
    c = row.get('message', {}).get('content')
    if isinstance(c, list) and any(b.get('type') == 'tool_result' for b in c):
        return None
    t = text_of(c).strip()
    if not t or t.startswith(('<command-', '<local-command', '<task-notification>', '<system-reminder>')):
        return None
    return t


def is_prompt(row):
    return prompt_text(row) is not None


def card_of(session, transcript, rows):
    first, start = rows[0][1], rows[0][0]
    prompt = prompt_text(first).strip()
    who, event_id = 'user', ''
    m = CHANNEL.search(prompt)
    if m:
        who, event_id = ATTR(m.group(1), 'sender_id') or ATTR(m.group(1), 'sender') or 'channel', ATTR(m.group(1), 'event_id')
        prompt = re.sub(r'^\[[^\]]+\]:\s*', '', m.group(2).strip())
    said, tools, anchors = [], [], []
    for _, r, _ in rows[1:]:
        c = r.get('message', {}).get('content')
        if r.get('type') == 'assistant':
            for b in c if isinstance(c, list) else []:
                if b.get('type') == 'text' and b.get('text', '').strip():
                    said.append(b['text'].strip())
                elif b.get('type') == 'tool_use':
                    tools.append(b.get('name', ''))
        for a in ANCHOR.findall(text_of(c)[:200000]):
            if a not in anchors:
                anchors.append(a)
    body = prompt[:1500]
    if said:
        body += '\n-> ' + ' / '.join(said)[-700:]
    if tools:
        body += '\ntools: ' + ', '.join(sorted(set(tools)))
    if anchors:
        body += '\nrefs: ' + ' '.join(anchors[:10])
    return dict(pointer=f'{session}:{first["uuid"]}', session=session, transcript=transcript, start=start,
                end=rows[-1][2], ts=first.get('timestamp', ''), who=who, event_id=event_id, body=body)


def config(db_path):
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(db_path)), 'config.json')) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def note_dirs(db_path):
    """{source: directory} from index.notes in <state>/config.json; each directory of .md files is mirrored."""
    return config(db_path).get('index', {}).get('notes', {})


def doc_dirs(db_path):
    """{source: directory} from index.docs in <state>/config.json; each directory's Markdown is indexed in chunks."""
    return config(db_path).get('index', {}).get('docs', {})


def recall_sources(db_path):
    """The sources a prompt is searched in: fold, every notes and docs source, and the vault only when index.vault names
    its replica and recall.vault is true."""
    cfg = config(db_path)
    vault = ['vault'] if cfg.get('index', {}).get('vault') and cfg.get('recall', {}).get('vault') is True else []
    return ['fold', *cfg.get('index', {}).get('notes', {}), *cfg.get('index', {}).get('docs', {}), *vault]


def claim_card(m):
    """One line for a vault claim: where it sits, what it says, and what backs it. The parts are cut, never the line,
    so the source and freshness always show."""
    backing = [f'source: {(m.get("source_title") or m.get("source_id"))[:120]}'] if m.get('source_title') or m.get('source_id') else []
    backing += [f'captured {m["captured"][:10]}'] if m.get('captured') else []
    return (f'[claim {m["claim"]}] {m["title"][:120]} > {m["heading"][:120]}: {" ".join(m["text"].split())[:400]} '
            f'({m["source_type"]}; {", ".join(backing + [m["freshness"]])})')


def build(a):
    transcript = a.transcript if a.transcript and os.path.exists(a.transcript) else find_transcript(a.session)
    if not transcript:
        print(json.dumps({'error': 'no transcript', 'session': a.session})); return 1
    db = connect(a.db)
    migrate(db)
    got = db.execute('SELECT offset FROM progress WHERE transcript=?', (transcript,)).fetchone()
    offset = got[0] if got else 0
    stretch, new, resume = [], [], offset
    with open(transcript, 'rb') as f:
        f.seek(offset)
        pos = offset
        for line in f:
            end = pos + len(line)
            try:
                row = json.loads(line)
            except ValueError:
                pos = end; continue
            if row.get('sessionId') not in (None, a.session):
                pos = end; continue
            boundary = is_prompt(row) or row.get('isCompactSummary')
            if boundary:
                if stretch:
                    new.append(card_of(a.session, transcript, stretch))
                stretch, resume = [], pos
            if is_prompt(row) or (stretch and row.get('type') in ('user', 'assistant') and not row.get('isSidechain')):
                stretch.append((pos, row, end))
            pos = end
    added = []
    for c in new:
        if db.execute('INSERT OR IGNORE INTO card VALUES (:pointer,:session,:transcript,:start,:end,:ts,:who,:event_id,:body)', c).rowcount:
            index_card(db, c)
            added.append(c)
    db.execute('INSERT OR REPLACE INTO progress VALUES (?, ?)', (transcript, resume))
    db.commit()
    if a.ledger_cards and added:
        try:
            with open(a.ledger_cards, 'x') as out:
                for c in added:
                    out.write(json.dumps({k: c[k] for k in ('pointer', 'ts', 'who', 'event_id', 'body')}) + '\n')
        except FileExistsError:
            pass
    notes = {}
    for src, d in note_dirs(a.db).items():
        notes[src] = memindex.sync_notes(db, os.path.expanduser(d), src)
    for src, d in doc_dirs(a.db).items():
        notes[src] = memindex.sync_docs(db, os.path.expanduser(d), src)
    vault = config(a.db).get('index', {}).get('vault')
    if vault:
        notes['vault'] = memindex.sync_vault(db, vault)
    print(json.dumps({'transcript': transcript, 'added': len(added), 'offset': resume, 'notes': notes}))
    return 0


def front(body, key):
    m = re.search(r'^' + key + r':\s*"?(.*?)"?\s*$', body.split('\n---', 1)[0] if body.startswith('---') else '', re.M)
    return m.group(1) if m else ''


THREAD_TURNS, THREAD_SECONDS = 2, 3600


def thread_of(db_path, room, body, remember=True):
    """The last THREAD_TURNS messages from this room within THREAD_SECONDS, oldest first, then remember this one.
    Kept in <state>/recall-thread.json because the query runs as a fresh process per prompt."""
    path = os.path.join(os.path.dirname(os.path.abspath(db_path)), 'recall-thread.json')
    try:
        with open(path) as f:
            rooms = json.load(f)
    except (OSError, ValueError):
        rooms = {}
    now = time.time()
    turns = [t for t in rooms.get(room, []) if now - t[0] < THREAD_SECONDS][-THREAD_TURNS:]
    if remember and body:
        rooms[room] = (turns + [[now, body[:600]]])[-THREAD_TURNS:]
        rooms = {r: v for r, v in rooms.items() if v and now - v[-1][0] < THREAD_SECONDS}
        try:
            tmp = f'{path}.{os.getpid()}.tmp'
            with open(tmp, 'w') as f:
                json.dump(rooms, f)
            os.replace(tmp, path)
        except OSError as err:  # a lost turn costs one follow-up its context; it must not cost the recall
            print(f'cards: thread not saved ({err!r})', file=sys.stderr)
    return [t[1] for t in turns]


def query(a):
    """The memory notes, documents, vault claims and cards worth attaching to this prompt; usually none."""
    migrate(connect(a.db))
    msg = memindex.clean(a.text)
    if msg['kind'] == 'notice' or not msg['body']:
        print('[]'); return 0
    thread = json.loads(a.thread) if a.thread is not None else thread_of(a.db, msg['room'] or msg['kind'], msg['body'])
    allowed = recall_sources(a.db)
    sources = [s for s in a.sources.split(',') if s != 'vault' or s in allowed] if a.sources else allowed
    exclude = set(filter(None, (a.exclude or '').split(','))) | {f'{s}:MEMORY.md' for s in note_dirs(a.db)}
    cands = memindex.candidates(a.db, msg['body'], sources, thread)
    hits = memindex.gate(cands or [], len(memindex.terms_of(msg['body'])), exclude)[:a.k]
    out = []
    for c in hits:
        m = c['meta']
        h = dict(pointer=c['pointer'], source=c['source'], ts=c['ts'], who=m.get('who', c['source']), event_id=m.get('event_id', ''),
                 path=m.get('path'), body=c['body'], p=round(c['p'], 3))
        if c['source'] == 'vault':
            h.update(card=claim_card(m))
        elif c['source'] != 'fold':
            name =os.path.basename(m.get('path') or c['pointer']).removesuffix('.md')
            text = re.sub(r'^---\n[\s\S]*?\n---\n', '', c['body']).strip()
            if m.get('title'):  # a document chunk: its title and section, then the chunk
                h.update(name=m['title'] + (' / ' + m['heading'] if m.get('heading') else ''), description=re.sub(r'^(#+ .*\n+)+', '', text)[:400])
            else:
                h.update(name=front(c['body'], 'name') or name, description=front(c['body'], 'description') or text[:300])
        out.append(h)
    print(json.dumps(out))
    return 0


def unfold(a):
    db = connect(a.db)
    p = a.pointer
    row = (db.execute('SELECT transcript, start, end FROM card WHERE event_id=?', (p[6:],)).fetchone() if p.startswith('event:')
           else db.execute('SELECT transcript, start, end FROM card WHERE pointer=?', (p,)).fetchone())
    if not row:
        print('unfold: no card for ' + p, file=sys.stderr); return 1
    transcript, start, end = row
    with open(transcript, 'rb') as f:
        f.seek(start)
        chunk = f.read(end - start)
    for line in chunk.splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        t = prompt_text(r)
        if t is None:
            if r.get('type') not in ('user', 'assistant'):
                continue
            t = text_of(r.get('message', {}).get('content'))
        if a.max_tool_chars and len(t) > a.max_tool_chars:
            t = t[:a.max_tool_chars] + f'\n[... {len(t) - a.max_tool_chars} more chars; --max-tool-chars 0 for all]'
        print(f'--- {r["type"]} {r.get("uuid", "")} {r.get("timestamp", "")}\n{t}')
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    dflt = os.path.expanduser(os.environ.get('FOLD_STATE_DIR', '~/.claude/state/fold')) + '/cards.db'
    b = sub.add_parser('build'); b.add_argument('--db', default=dflt); b.add_argument('--session', required=True)
    b.add_argument('--transcript'); b.add_argument('--ledger-cards')
    q = sub.add_parser('query'); q.add_argument('--db', default=dflt); q.add_argument('--text', required=True)
    q.add_argument('--k', type=int, default=4); q.add_argument('--exclude')
    q.add_argument('--thread', help='JSON list of the previous turns; default: kept per room in the state directory')
    q.add_argument('--sources', help='default: fold and every index.notes and index.docs source')
    u = sub.add_parser('unfold'); u.add_argument('pointer'); u.add_argument('--db', default=dflt)
    u.add_argument('--max-tool-chars', type=int, default=4000)
    a = ap.parse_args()
    return {'build': build, 'query': query, 'unfold': unfold}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
