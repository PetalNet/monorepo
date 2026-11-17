"""One recall index for every memory source: fold cards, memory notes, and Markdown documents.

Each source writes documents (id, source, ts, meta, body) into the same SQLite file. For each prompt:
  clean       the words the person wrote: the channel tag, untrusted-content trailer, room prefix and media lines go,
              and a harness notice (a task notification) is not searched at all
  candidates  per source, the top POOL by cosine from the resident embedder (bin/embedder.py) and the top POOL by BM25
              over FTS5; a short message's dense query leans toward the last turns of its room
  gate        a per-source logistic model scores each of the TOP closest: cosine, how far it stands above its query's
              own field (z), and whether a rare query term matched it. Attach above the source's threshold; usually none
Without the embedder nothing attaches, and the embedder is started for the next prompt. This module is stdlib-only so
the per-prompt hook can run it under plain python3 -I.

  memindex.py sync-notes --db DB --dir DIR      index a directory of Markdown notes as source "memory"
  memindex.py search --db DB --text TEXT [--sources fold,memory] [--thread JSON]   every candidate and the gate's call
"""
import argparse, glob, hashlib, json, math, os, re, socket, sqlite3, subprocess, sys, time

WORD = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{2,}')
STOP = set('the and for with that this you are was have from what which when where who how not but can will just '
           'into about your they them then than there their reply only use tool tools run say please'.split())
MIN_IDF = 5.0      # BM25 idf of a term in about 1 card in 150; one such term alone is enough to qualify a document
POOL = 60


def connect(path):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.executescript('''
      CREATE TABLE IF NOT EXISTS doc(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, source TEXT NOT NULL, ts TEXT,
        meta TEXT, body TEXT, hash TEXT);
      CREATE INDEX IF NOT EXISTS doc_source ON doc(source);
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(body, tokenize='porter unicode61');
      CREATE TABLE IF NOT EXISTS doc_vec(rowid INTEGER PRIMARY KEY, model TEXT, hash TEXT, vec BLOB);''')
    return db


def put(db, source, id, ts, body, meta=None, extra=''):
    """Insert or replace one document. extra is searchable text that is not part of the body."""
    h = hashlib.sha1((body + extra).encode()).hexdigest()[:16]
    old = db.execute('SELECT rowid, hash FROM doc WHERE id=?', (id,)).fetchone()
    if old and old[1] == h:
        return False
    if old:
        db.execute('DELETE FROM doc_fts WHERE rowid=?', (old[0],))
        db.execute('UPDATE doc SET source=?, ts=?, meta=?, body=?, hash=? WHERE rowid=?',
                   (source, ts, json.dumps(meta or {}), body, h, old[0]))
        rowid = old[0]
    else:
        rowid = db.execute('INSERT INTO doc(id, source, ts, meta, body, hash) VALUES (?,?,?,?,?,?)',
                           (id, source, ts, json.dumps(meta or {}), body, h)).lastrowid
    db.execute('INSERT INTO doc_fts(rowid, body) VALUES (?, ?)', (rowid, body + ' ' + extra))
    return True


def drop(db, id):
    old = db.execute('SELECT rowid FROM doc WHERE id=?', (id,)).fetchone()
    if old:
        for t in ('doc_fts', 'doc_vec', 'doc'):
            db.execute(f'DELETE FROM {t} WHERE rowid=?', (old[0],))


def sync_notes(db, directory, source='memory'):
    """Mirror a directory of .md notes: changed files are re-indexed, deleted files leave the index."""
    seen, changed = set(), 0
    for path in sorted(glob.glob(os.path.join(directory, '*.md'))):
        id = f'{source}:{os.path.basename(path)}'
        seen.add(id)
        with open(path, errors='replace') as f:
            body = f.read()
        ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(os.path.getmtime(path)))
        changed += put(db, source, id, ts, body[:20000], {'path': path})
    for (id,) in db.execute('SELECT id FROM doc WHERE source=?', (source,)).fetchall():
        if id not in seen:
            drop(db, id); changed += 1
    db.commit()
    return changed


def terms_of(text):
    return list(dict.fromkeys(w.lower() for w in WORD.findall(text) if w.lower() not in STOP))[:24]


def phrase(t):
    return '"' + t.replace('"', '') + '"'


def lexical(db, terms, sources):
    """(candidates in BM25 order, {candidate: matched terms}, {term: idf}, idf bar) for an OR match of the terms."""
    none = ([], {}, {}, 0)
    if not terms:
        return none
    n = db.execute('SELECT count(*) FROM doc').fetchone()[0]
    idf = {}
    for t in terms:
        df = db.execute('SELECT count(*) FROM doc_fts WHERE doc_fts MATCH ?', (phrase(t),)).fetchone()[0]
        if df:
            idf[t] = math.log((n - df + 0.5) / (df + 0.5) + 1)
    if not idf:
        return none
    marks = ','.join('?' * len(sources))
    rows = db.execute(f'SELECT doc_fts.rowid FROM doc_fts JOIN doc d ON d.rowid=doc_fts.rowid WHERE doc_fts MATCH ? '
                      f'AND d.source IN ({marks}) ORDER BY bm25(doc_fts) LIMIT {POOL}',
                      (' OR '.join(map(phrase, idf)), *sources)).fetchall()
    cands = [r[0] for r in rows]
    if not cands:
        return none
    matched = {r: [] for r in cands}
    ids = ','.join(map(str, cands))
    for t in idf:
        for (r,) in db.execute(f'SELECT rowid FROM doc_fts WHERE doc_fts MATCH ? AND rowid IN ({ids})', (phrase(t),)):
            matched[r].append(t)
    return cands, matched, idf, min(MIN_IDF, 0.5 * math.log((n - 0.5) / 1.5 + 1))


def state_dir(db_path):
    return os.path.dirname(os.path.abspath(db_path))


def answer(s):
    try:
        buf = b''
        while not buf.endswith(b'\n'):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        return [tuple(x) for x in json.loads(buf)['hits']]
    except (OSError, ValueError, KeyError) as err:
        print(f'memindex: embedder failed ({err!r}), nothing attached', file=sys.stderr)
        return None


def start_embedder(db_path):
    d = state_dir(db_path)
    py = os.path.join(d, 'embed-venv', 'bin', 'python')
    stamp = os.path.join(d, 'embed.starting')
    if not os.path.exists(py):
        return
    try:
        if time.time() - os.path.getmtime(stamp) < 120:
            return
    except OSError:
        pass
    open(stamp, 'w').close()
    libs = ':'.join(glob.glob(os.path.join(d, 'embed-libs', '*', 'lib')))
    env = dict(os.environ, LD_LIBRARY_PATH=libs, HF_HUB_OFFLINE='1')
    with open(os.path.join(d, 'embed.log'), 'a') as log:
        subprocess.Popen([py, '-I', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'embedder.py'), '--db', db_path],
                         env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)


CHANNEL = re.compile(r'<channel\b([^>]*)>([\s\S]*?)(?:</channel>|$)')  # the hook cuts long prompts before the closing tag
PREFIX = re.compile(r'^\[(![^\] ]+)(?: - ([^\]]*))?\] \[([^\]]*)\]:\s*')
WRAPPED = re.compile(r'<(system-reminder|task-notification|command-[\w-]+|local-command-[\w-]+)>[\s\S]*?</\1>')
MEDIA = re.compile(r'^\[(?:file|image|audio|video|voice)[^\]\n]*received[^\]\n]*\]\s*', re.M | re.I)


def clean(text):
    """What the person wrote, and where. The hook's prompt text wraps a Matrix message in a <channel> tag with room and
    event ids and an untrusted-content trailer; ranked as-is, those words outvote a short message ("Status?" pulled four
    cards about hermes-link routing). kind is 'channel', 'user' (typed in the terminal) or 'notice' (only harness blocks
    such as task notifications, which report work the session just did)."""
    m = CHANNEL.search(text or '')
    attr = lambda k: (re.search(k + r'="([^"]*)"', m.group(1)) or [None, ''])[1] if m else ''
    body = (m.group(2) if m else WRAPPED.sub('', text or '')).strip()
    room, room_name, sender = attr('room_id'), '', attr('sender')
    p = PREFIX.match(body)
    if p:
        room, room_name, sender, body = p.group(1), p.group(2) or '', p.group(3), body[p.end():]
    body = MEDIA.sub('', body).strip()
    kind = 'channel' if m else 'user' if body else 'notice'
    return dict(body=body, room=room, room_name=room_name, sender=sender, sender_id=attr('sender_id'), kind=kind)


SECRET = re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|(?<![\w-])sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}'
                    r'|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}'
                    r'|(?i:token|pass(?:word|wd)?|secret|api[ _-]?key)\b[^\n`]{0,30}?(?:[:=]\s*|`|\bis\s+)["\'`]?'
                    r'(?=[^\s`"\']*\d)(?=[^\s`"\']*[A-Za-z])[^\s`"\'<>]{12,}')  # "token: x", "pass `x`", "the key is x"
CHUNK = 1200


def chunks(text):
    """Heading-led sections of a Markdown file, merged up to CHUNK characters and split at paragraphs past it."""
    text = re.sub(r'^---\n[\s\S]*?\n---\n', '', text)
    sections, out = re.split(r'(?m)^(?=#{1,3} )', text), []
    for sec in sections:
        heading = sec.split('\n', 1)[0].lstrip('#').strip() if sec.startswith('#') else ''
        paras, cur = re.split(r'\n\s*\n', sec), ''
        for para in paras:
            if cur and len(cur) + len(para) > CHUNK:
                out.append((heading, cur.strip())); cur = ''
            cur += para[:CHUNK * 2] + '\n\n'
        if cur.strip():
            if out and out[-1][0] == heading and len(out[-1][1]) + len(cur) < CHUNK // 2:
                out[-1] = (heading, out[-1][1] + '\n\n' + cur.strip())
            else:
                out.append((heading, cur.strip()))
    return [(h, b) for h, b in out if len(b) > 80]


def sync_docs(db, directory, source, max_bytes=100000, skip=r'(^|/)(result|.*\.log|.*\.raw)\.md$'):
    """Mirror the Markdown files under a directory as heading-led chunks. Only *.md is read, so token files beside them
    are never opened; a file over max_bytes or matching skip (raw research dumps and logs) is left out, and a chunk
    that looks like it holds a credential is dropped."""
    seen, changed, skip = set(), 0, re.compile(skip)
    for path in sorted(glob.glob(os.path.join(directory, '**', '*.md'), recursive=True)):
        rel = os.path.relpath(path, directory)
        if skip.search(rel) or os.path.getsize(path) > max_bytes:
            continue
        with open(path, errors='replace') as f:
            text = f.read()
        title = (re.search(r'(?m)^# (.+)$', text) or [None, os.path.basename(path)[:-3]])[1].strip()
        ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(os.path.getmtime(path)))
        for i, (heading, body) in enumerate(chunks(text)):
            if SECRET.search(body):
                continue
            id = f'{source}:{rel}#{i}'
            seen.add(id)
            changed += put(db, source, id, ts, body, {'path': path, 'title': title, 'heading': heading}, title + ' ' + heading)
    for (id,) in db.execute('SELECT id FROM doc WHERE source=?', (source,)).fetchall():
        if id not in seen:
            drop(db, id); changed += 1
    db.commit()
    return changed


def embed_query(db_path, text, context, context_weight, sources, n, timeout=1.0):
    """Start a search on the resident embedder; returns a function that waits for {rowid: cosine}, or None."""
    sock = os.path.join(state_dir(db_path), 'embed.sock')
    try:
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(timeout)
        s.connect(sock)
        s.sendall(json.dumps({'op': 'search', 'text': text, 'context': context, 'context_weight': context_weight,
                              'sources': sources, 'n': n}).encode() + b'\n')
    except OSError as err:
        s.close()
        print(f'memindex: embedder unreachable ({err!r}), nothing attached', file=sys.stderr)
        start_embedder(db_path)
        return lambda: None
    def wait():
        hits = answer(s)
        return dict(hits) if hits is not None else None
    return wait


def candidates(db_path, text, sources, thread=(), context_weight=0.5, n=POOL, allow=None, timeout=1.0):
    """Every candidate either ranker puts in its top n per source, with the features the gate reads:
    cos (cosine to the query), lex (IDF mass of matched rare terms; 0 when none qualified), and the two ranks.

    The query is the message. When the message is short (under SHORT content terms) the last turns of the same room
    are mixed into the dense query at context_weight, so "and the other one?" means what the thread was about;
    the lexical side always uses the message alone."""
    db = connect(db_path)
    terms = terms_of(text)
    context = ' '.join(thread)[-1500:] if thread and len(terms) < SHORT else ''
    pending = embed_query(db_path, text[:QUERY_CHARS], context, context_weight, sources, n * 4 if allow else n, timeout)
    lex = {}
    for s in sources:
        cands, matched, idf, bar = lexical(db, terms, [s])
        for rank, r in enumerate(cands):
            mass = sum(idf[t] for t in matched[r])
            lex[r] = (rank, mass if mass >= bar else 0.0)
    cos = pending()
    if cos is None:
        return None
    rows = set(lex) | set(cos)
    meta = {r: (id, src, ts, m, body) for r, id, src, ts, m, body in
            db.execute(f'SELECT rowid, id, source, ts, meta, body FROM doc WHERE rowid IN ({",".join(map(str, rows)) or "0"})')}
    dense_rank, out = {}, []
    for s in sources:
        ranked = sorted((r for r in cos if r in meta and meta[r][1] == s and (allow is None or allow(meta[r]))), key=cos.get, reverse=True)
        dense_rank.update((r, i) for i, r in enumerate(ranked[:n]))
    for r in rows:
        if r not in meta or (allow is not None and not allow(meta[r])):
            continue
        id, src, ts, m, body = meta[r]
        if r not in dense_rank and r not in lex:
            continue
        out.append(dict(rowid=r, pointer=id, source=src, ts=ts, meta=json.loads(m or '{}'), body=body,
                        cos=cos.get(r, 0.0), lex=lex.get(r, (None, 0.0))[1], lex_rank=lex.get(r, (None,))[0],
                        dense_rank=dense_rank.get(r)))
    return out


SHORT = 6
QUERY_CHARS = 600  # of the message the embedder reads: about 150 tokens; at 1500 a long message took ~300 ms on this CPU
# Per source, a logistic model of "would this help answer the message", fitted on 59 real prompts and 1,310 candidates
# graded blind (test/recall_eval.json). Cosine alone separates poorly: a generic message pulls generically high cosines,
# so the models lean on how far a candidate stands above its own query's top TOP (z) and on a rare query term matching
# it (lex). A source without a model (documents: 7 helpful candidates, none picked precisely) is indexed but never attached.
MODELS = {
    'fold': dict(bias=-3.689, cos=-0.643, z=1.013, lex=1.233, lex_mass=0.19, rank=-0.367, terms=0.175),
    'memory': dict(bias=-5.136, cos=-0.516, z=1.104, lex=1.248, lex_mass=1.497, rank=0.122, terms=-1.014),
}
THRESHOLDS = {'fold': 0.5, 'memory': 0.4}  # 2-fold CV: precision 0.62, recall 0.18, nothing attached for 75% of prompts
CAPS = {'fold': 2, 'memory': 2}
MAX_ATTACH = 3
TOP = 20


def score(cands, nterms):
    """Set each candidate's probability of helping, p. Only the TOP closest of a source with a model are scored."""
    for s in {c['source'] for c in cands}:
        mine = sorted((c for c in cands if c['source'] == s), key=lambda c: -c['cos'])
        w = MODELS.get(s)
        top = [c['cos'] for c in mine[:TOP]]
        mu = sum(top) / len(top)
        sd = (sum((x - mu) ** 2 for x in top) / len(top)) ** 0.5 or 0.01
        for rank, c in enumerate(mine):
            if not w or rank >= TOP:
                c['p'] = 0.0
                continue
            x = dict(cos=c['cos'], z=(c['cos'] - mu) / sd, lex=1.0 if c['lex'] > 0 else 0.0, lex_mass=min(c['lex'], 20) / 10,
                     rank=1 / (1 + rank), terms=min(nterms, 20) / 10)
            c['p'] = 1 / (1 + math.exp(-(w['bias'] + sum(w[f] * v for f, v in x.items()))))
    return cands


def gate(cands, nterms, exclude=(), thresholds=THRESHOLDS, max_attach=MAX_ATTACH):
    """The candidates worth attaching, most likely first; usually none. At most CAPS per source, one pointer per
    document, max_attach in all."""
    out, per = [], {}
    for c in sorted(score(cands, nterms), key=lambda c: -c['p']):
        doc = c['meta'].get('path') or c['pointer']
        if c['p'] < thresholds.get(c['source'], 1.1) or c['pointer'] in exclude or per.get(c['source'], 0) >= CAPS.get(c['source'], 1) \
                or any((o['meta'].get('path') or o['pointer']) == doc for o in out):
            continue
        per[c['source']] = per.get(c['source'], 0) + 1
        out.append(c)
        if len(out) >= max_attach:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    dflt = os.path.expanduser(os.environ.get('FOLD_STATE_DIR', '~/.claude/state/fold')) + '/cards.db'
    n = sub.add_parser('sync-notes'); n.add_argument('--db', default=dflt); n.add_argument('--dir', required=True)
    n.add_argument('--source', default='memory')
    s = sub.add_parser('search', help='every candidate with its features, and which the gate keeps')
    s.add_argument('--db', default=dflt); s.add_argument('--text', required=True)
    s.add_argument('--sources', default='fold'); s.add_argument('--thread', default='[]')
    a = ap.parse_args()
    if a.cmd == 'sync-notes':
        print(json.dumps({'changed': sync_notes(connect(a.db), a.dir, a.source)}))
    else:
        cands = candidates(a.db, clean(a.text)['body'], a.sources.split(','), json.loads(a.thread)) or []
        kept = {c['pointer'] for c in gate(cands, len(terms_of(clean(a.text)['body'])))}
        for c in sorted(cands, key=lambda c: -c['cos'])[:20]:
            print(json.dumps(dict(pointer=c['pointer'], kept=c['pointer'] in kept, cos=round(c['cos'], 3), lex=round(c['lex'], 2),
                                  p=round(c.get('p', 0), 3), body=' '.join(c['body'].split())[:120])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
