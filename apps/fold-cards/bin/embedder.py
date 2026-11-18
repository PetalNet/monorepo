"""Resident embedding server for memindex.py. Runs under <state>/embed-venv (see bin/embed-setup).

  embedder.py --db DB [--once]

Holds BAAI/bge-small-en-v1.5 (quantized ONNX, CPU) and every document vector in memory, answers searches on
<state>/embed.sock, and embeds documents that lack a current vector every SYNC_EVERY seconds. Vectors persist in
the doc_vec table, so a restart reloads instead of re-embedding. --once embeds what is missing and exits.
"""
import argparse, fcntl, json, os, re, socket, sqlite3, sys, threading, time

import numpy as np
from fastembed import TextEmbedding

MODEL = 'BAAI/bge-small-en-v1.5'
SYNC_EVERY = 20
BATCH = 32  # rows per commit; the model sees 8 at a time
NOISE = re.compile(r'^(?:tools|refs): .*$', re.M)
ROOM = re.compile(r'^\[![^\]]*\] \[[^\]]*\]:\s*')


FRONT = re.compile(r'^---\n([\s\S]*?)\n---\n')
FIELD = re.compile(r'^(?:name|description):\s*"?(.*?)"?\s*$', re.M)


def doc_text(body):
    """What a document is about: a note's name and description in place of its YAML frontmatter (whose session ids and
    metadata keys would otherwise fill the 512 tokens the model reads), without card tool and ref lines or room prefixes."""
    body = body or ''
    m = FRONT.match(body)
    if m:
        body = ' '.join(FIELD.findall(m.group(1))) + '\n\n' + body[m.end():]
    return ROOM.sub('', NOISE.sub('', body)).strip()[:1200]  # 12 layers on a VM CPU without AVX2: about 7 docs/s per 4 threads at this length


class Index:
    def __init__(self, db_path, threads=2):
        self.db_path = db_path
        state = os.path.dirname(os.path.abspath(db_path))
        self.model = TextEmbedding(MODEL, cache_dir=os.path.join(state, 'models'), threads=threads,
                                   enable_cpu_mem_arena=False)  # the arena keeps every burst's peak resident
        self.lock = threading.Lock()
        self.rowids = np.zeros(0, dtype=np.int64)
        self.sources = np.zeros(0, dtype=object)
        self.vecs = np.zeros((0, 384), dtype=np.float32)
        self.load()

    def db(self):
        return sqlite3.connect(self.db_path, timeout=30)

    def load(self):
        rows = self.db().execute('SELECT v.rowid, d.source, v.vec FROM doc_vec v JOIN doc d ON d.rowid=v.rowid '
                                 'WHERE v.model=? AND v.hash=d.hash', (MODEL,)).fetchall()
        with self.lock:
            self.rowids = np.array([r[0] for r in rows], dtype=np.int64)
            self.sources = np.array([r[1] for r in rows], dtype=object)
            self.vecs = np.frombuffer(b''.join(r[2] for r in rows), dtype=np.float32).reshape(-1, 384).copy()

    def sync(self):
        db = self.db()
        todo = db.execute('SELECT d.rowid, d.source, d.hash, d.body FROM doc d LEFT JOIN doc_vec v ON v.rowid=d.rowid '
                          'WHERE v.rowid IS NULL OR v.hash IS NOT d.hash OR v.model IS NOT ?', (MODEL,)).fetchall()
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            vecs = np.array(list(self.model.passage_embed([doc_text(r[3]) for r in chunk], batch_size=8)), dtype=np.float32)
            db.executemany('INSERT OR REPLACE INTO doc_vec(rowid, model, hash, vec) VALUES (?,?,?,?)',
                           [(r[0], MODEL, r[2], v.tobytes()) for r, v in zip(chunk, vecs)])
            db.commit()
            ids = np.array([r[0] for r in chunk], dtype=np.int64)
            with self.lock:
                keep = ~np.isin(self.rowids, ids)
                self.rowids = np.concatenate([self.rowids[keep], ids])
                self.sources = np.concatenate([self.sources[keep], np.array([r[1] for r in chunk], dtype=object)])
                self.vecs = np.concatenate([self.vecs[keep], vecs])
        gone = db.execute('SELECT count(*) FROM doc').fetchone()[0] < len(self.rowids)
        if gone:
            self.load()
        return len(todo)

    def search(self, text, sources, n, context='', context_weight=0.0):
        """Top n (rowid, cosine) of each source. With context (the last turns of the thread), the query vector leans
        toward it by context_weight."""
        q = np.array(list(self.model.query_embed([text]))[0], dtype=np.float32)
        if context and context_weight > 0:
            q = q + context_weight * np.array(list(self.model.query_embed([context]))[0], dtype=np.float32)
            q /= np.linalg.norm(q)
        with self.lock:
            cos = self.vecs @ q
            hits = []
            for mask in ([self.sources == s for s in sources] if sources else [np.ones(len(cos), dtype=bool)]):
                c = np.where(mask, cos, -1.0)
                hits += [[int(self.rowids[i]), float(c[i])] for i in np.argsort(-c)[:n] if c[i] > -1.0]
            return hits


def serve(index, sock_path):
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(sock_path)
    os.chmod(sock_path, 0o600)
    srv.listen(8)

    def handle(conn):
        with conn:
            buf = b''
            while not buf.endswith(b'\n'):
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            req = json.loads(buf)
            if req.get('op') == 'search':
                t0 = time.perf_counter()
                hits = index.search(req['text'][:4000], req.get('sources'), int(req.get('n', 60)),
                                    req.get('context') or '', float(req.get('context_weight') or 0))
                conn.sendall(json.dumps({'hits': hits, 'ms': round((time.perf_counter() - t0) * 1000, 1)}).encode() + b'\n')
            elif req.get('op') == 'sync':
                conn.sendall(json.dumps({'embedded': index.sync()}).encode() + b'\n')

    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--threads', type=int, default=2)
    a = ap.parse_args()
    sock_path = os.path.join(os.path.dirname(os.path.abspath(a.db)), 'embed.sock')
    lock = open(sock_path + '.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0  # another embedder owns this state directory
    os.nice(10)  # backfill and sync must not starve the session that started it
    index = Index(a.db, a.threads)
    if a.once:
        print(json.dumps({'embedded': index.sync(), 'vectors': len(index.rowids)}))
        return 0
    if os.path.exists(sock_path):
        os.unlink(sock_path)

    def syncer():
        while True:
            try:
                index.sync()
            except Exception as e:
                print(f'sync failed: {e!r}', file=sys.stderr, flush=True)
            time.sleep(SYNC_EVERY)

    threading.Thread(target=syncer, daemon=True).start()
    print(json.dumps({'serving': sock_path, 'vectors': len(index.rowids), 'pid': os.getpid()}), flush=True)
    serve(index, sock_path)


if __name__ == '__main__':
    sys.exit(main())
