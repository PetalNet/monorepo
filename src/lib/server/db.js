import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Local SQLite is the source of truth (design: tracker-design-2026-05-26.md).
const DB_PATH = process.env.TASKS_DB_PATH || 'tasks.db';
try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch {}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    backend    TEXT NOT NULL DEFAULT 'local_private',   -- local_private | github_public
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    kind       TEXT    NOT NULL DEFAULT 'task',          -- task | idea
    title      TEXT    NOT NULL,
    body       TEXT    DEFAULT '',
    status     TEXT    NOT NULL DEFAULT 'todo',          -- inbox | todo | doing | blocked | done | dropped
    priority   INTEGER NOT NULL DEFAULT 2,               -- 0=P0 (highest) .. 3=P3
    up_next    INTEGER NOT NULL DEFAULT 0,
    rank       REAL    NOT NULL DEFAULT 0,               -- manual order ("do this then that"), NOT priority
    parent_id  INTEGER REFERENCES tasks(id),
    blocked_on TEXT    DEFAULT '',
    created_by TEXT    DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL REFERENCES tasks(id),
    author     TEXT DEFAULT '',
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- append-only log: the basis for git export + future sync (design: no CRDTs in v1)
  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY,
    task_id INTEGER,
    type    TEXT NOT NULL,
    data    TEXT,
    at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const log = (task_id, type, data) =>
  db.prepare('INSERT INTO events (task_id,type,data) VALUES (?,?,?)').run(task_id, type, data ? JSON.stringify(data) : null);

const ACTIVE = "status NOT IN ('done','dropped')";
const where = (p) => (p ? 'AND project_id=@p' : '');
const args = (p) => (p ? { p } : {});

export const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
export const listComments = (tid) => db.prepare('SELECT * FROM comments WHERE task_id=? ORDER BY created_at').all(tid);
export function addComment(task_id, author, body) {
  const r = db.prepare('INSERT INTO comments (task_id,author,body) VALUES (?,?,?)').run(task_id, author || '', body);
  log(task_id, 'comment', { author, body });
  return Number(r.lastInsertRowid);
}
export const listProjects = () => db.prepare('SELECT * FROM projects ORDER BY name').all();
export const getProjectByName = (name) => db.prepare('SELECT * FROM projects WHERE name=?').get(name);

// Top-level items per section (children render nested under their parent — work isn't flat, per Bob).
export const upNext  = (p) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=1 AND parent_id IS NULL AND ${ACTIVE} ${where(p)} ORDER BY rank, priority, updated_at DESC`).all(args(p)));
export const inbox   = (p) => db.prepare(`SELECT * FROM tasks WHERE kind='idea' AND status='inbox' AND parent_id IS NULL ${where(p)} ORDER BY created_at DESC`).all(args(p));
export const backlog = (p) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=0 AND parent_id IS NULL AND NOT (kind='idea' AND status='inbox') AND ${ACTIVE} ${where(p)} ORDER BY priority, rank, updated_at DESC`).all(args(p)));

// sub-task hierarchy (beads-style breakdown)
export const children = (pid) => withKids(db.prepare(`SELECT * FROM tasks WHERE parent_id=? AND ${ACTIVE} ORDER BY rank, priority`).all(pid));
const withKids = (rows) => rows.map((r) => ({ ...r, kids: children(r.id) }));

// The agent query (MCP get_ready, phase 2): actionable, unblocked, up-next first then by manual rank.
export const ready = (p) => db.prepare(`SELECT * FROM tasks WHERE status IN ('todo','doing') AND (blocked_on='' OR blocked_on IS NULL) ${where(p)} ORDER BY up_next DESC, rank, priority`).all(args(p));

// append to the end of the Up Next order
export const nextUpNextRank = () => (db.prepare('SELECT COALESCE(MAX(rank),0)+1 AS r FROM tasks WHERE up_next=1').get().r);

export function ensureProject(name, backend = 'local_private') {
  const found = getProjectByName(name);
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO projects (name,backend) VALUES (?,?)').run(name, backend).lastInsertRowid);
}

export function createTask(t) {
  const kind = t.kind ?? 'task';
  const r = db.prepare(
    `INSERT INTO tasks (project_id,kind,title,body,status,priority,up_next,rank,parent_id,created_by)
     VALUES (@project_id,@kind,@title,@body,@status,@priority,@up_next,@rank,@parent_id,@created_by)`
  ).run({
    project_id: t.project_id ?? null,
    kind,
    title: t.title,
    body: t.body ?? '',
    status: t.status ?? (kind === 'idea' ? 'inbox' : 'todo'),
    priority: t.priority ?? 2,
    up_next: t.up_next ? 1 : 0,
    rank: t.rank ?? 0,
    parent_id: t.parent_id ?? null,
    created_by: t.created_by ?? ''
  });
  const id = Number(r.lastInsertRowid);
  log(id, 'create', t);
  return id;
}

const PATCHABLE = ['title', 'body', 'status', 'priority', 'up_next', 'rank', 'parent_id', 'blocked_on', 'project_id', 'kind'];
export function updateTask(id, patch) {
  const cols = Object.keys(patch).filter((k) => PATCHABLE.includes(k));
  if (!cols.length) return;
  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c}=@${c}`).join(',')}, updated_at=datetime('now') WHERE id=@id`).run({ id, ...patch });
  log(id, 'update', patch);
}

export default db;
