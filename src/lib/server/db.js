import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Local SQLite is the source of truth (design: tracker-design-2026-05-26.md).
const DB_PATH = process.env.TASKS_DB_PATH || 'tasks.db';
try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch {}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // multi-writer safety (delegation + the Corner sync)

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

// Delegation columns (added incrementally — the live DB predates them). Idempotent.
function ensureColumns() {
  const have = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name));
  const adds = {
    assignee: "TEXT DEFAULT ''",            // which agent/human owns it
    capability: "TEXT DEFAULT ''",          // capability needed (build|research|web|...)
    type: "TEXT DEFAULT 'task'",
    claimed_by: "TEXT DEFAULT ''",          // agent that holds the active lease
    claim_token: "TEXT DEFAULT ''",
    lease_expires_at: 'TEXT',               // claim lease; Agent-a reaps when expired
    handoff_context: "TEXT DEFAULT ''",     // just-enough context for the worker
    acceptance_criteria: "TEXT DEFAULT ''", // what "done" means; Agent-a verifies against this
    result_summary: "TEXT DEFAULT ''",      // worker's concise result
    verification_status: "TEXT DEFAULT 'unverified'", // unverified|verified|rejected
    max_children: 'INTEGER DEFAULT 5',      // runaway-delegation guard
    budget: "TEXT DEFAULT ''",
    // Claude Corner merge: kind 'doc' (brief/ADR, body=writeup) and 'question' (async decision)
    options: "TEXT DEFAULT ''",             // JSON [{value,label}] for kind='question'
    answer: "TEXT DEFAULT ''",              // chosen value for kind='question'
    source: "TEXT DEFAULT ''",              // provenance for sync upserts, e.g. 'corner:post:42'
    owner: "TEXT DEFAULT ''",               // who created/owns it (authentik username)
    visibility: "TEXT DEFAULT 'shared'"     // shared | private (private = owner-only for humans)
  };
  for (const [name, def] of Object.entries(adds)) if (!have.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${def}`);
}
ensureColumns();

const log = (task_id, type, data) =>
  db.prepare('INSERT INTO events (task_id,type,data) VALUES (?,?,?)').run(task_id, type, data ? JSON.stringify(data) : null);

const ACTIVE = "status NOT IN ('done','dropped')";
const where = (p) => (p ? 'AND project_id=@p' : '');
// visibility filter for HUMAN web views: pass the logged-in user; omit for agents (they see all).
const vis = (me) => (me ? "AND (visibility='shared' OR owner=@me)" : '');
const qargs = (p, me) => ({ ...(p ? { p } : {}), ...(me ? { me } : {}) });
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

const TASKISH = "kind IN ('task','idea')"; // docs & questions are not part of the task checklist

// Top-level items per section (children render nested under their parent — work isn't flat, per Bob).
export const upNext  = (p, me) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=1 AND parent_id IS NULL AND ${TASKISH} AND ${ACTIVE} ${where(p)} ${vis(me)} ORDER BY rank, priority, updated_at DESC`).all(qargs(p, me)));
export const inbox   = (p, me) => db.prepare(`SELECT * FROM tasks WHERE kind='idea' AND status='inbox' AND parent_id IS NULL ${where(p)} ${vis(me)} ORDER BY created_at DESC`).all(qargs(p, me));
export const backlog = (p, me) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=0 AND parent_id IS NULL AND ${TASKISH} AND NOT (kind='idea' AND status='inbox') AND ${ACTIVE} ${where(p)} ${vis(me)} ORDER BY priority, rank, updated_at DESC`).all(qargs(p, me)));

// --- Claude Corner merge: docs (briefs/ADRs) + questions (async decisions) ---
export const listDocs = (p, me) => db.prepare(`SELECT * FROM tasks WHERE kind='doc' AND ${ACTIVE} ${where(p)} ${vis(me)} ORDER BY updated_at DESC`).all(qargs(p, me));
export const openQuestions = (p, me) => db.prepare(`SELECT * FROM tasks WHERE kind='question' AND (answer='' OR answer IS NULL) AND ${ACTIVE} ${where(p)} ${vis(me)} ORDER BY priority, created_at`).all(qargs(p, me));
export const answerQuestion = (id, value) => updateTask(id, { answer: value, status: 'done' });
export const createDoc = (project_id, title, body, created_by = '') => createTask({ kind: 'doc', title, body, status: 'todo', project_id, created_by });
export function createQuestion(project_id, title, context, options, created_by = '') {
  const id = createTask({ kind: 'question', title, body: context, status: 'todo', project_id, created_by });
  updateTask(id, { options: JSON.stringify(options || []) });
  return id;
}

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
    // tolerate a project row being passed instead of its id (caught via dogfood)
    project_id: (t.project_id && typeof t.project_id === 'object') ? t.project_id.id : (t.project_id ?? null),
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

const PATCHABLE = ['title', 'body', 'status', 'priority', 'up_next', 'rank', 'parent_id', 'blocked_on', 'project_id', 'kind',
  'assignee', 'capability', 'type', 'handoff_context', 'acceptance_criteria', 'result_summary', 'verification_status',
  'budget', 'max_children', 'claimed_by', 'claim_token', 'lease_expires_at', 'options', 'answer', 'source',
  'owner', 'visibility'];

export const getTaskBySource = (source) => db.prepare('SELECT * FROM tasks WHERE source=?').get(source);
export function updateTask(id, patch) {
  const cols = Object.keys(patch).filter((k) => PATCHABLE.includes(k));
  if (!cols.length) return;
  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c}=@${c}`).join(',')}, updated_at=datetime('now') WHERE id=@id`).run({ id, ...patch });
  log(id, 'update', patch);
}

// --- delegation: assignment, atomic claim/lease, report-back, verify, reap ---

export function assignTask(id, assignee, capability) {
  updateTask(id, { assignee, status: 'todo', ...(capability ? { capability } : {}) });
}

// Atomic claim: better-sqlite3 serializes writes, so this guarded UPDATE can't double-claim.
// Returns true iff THIS worker won the claim.
export function claimTask(id, worker, token) {
  const r = db.prepare(
    `UPDATE tasks SET status='doing', claimed_by=@worker, claim_token=@token,
       lease_expires_at=datetime('now','+30 minutes'), updated_at=datetime('now')
     WHERE id=@id AND assignee=@worker AND status='todo'
       AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))`
  ).run({ id, worker, token });
  if (r.changes) log(id, 'claim', { worker });
  return r.changes > 0;
}

// Worker reports back. Only the current lease holder may report.
export function reportTask(id, worker, token, { status, result_summary, blocked_on } = {}) {
  const t = getTask(id);
  if (!t || t.claimed_by !== worker || (token && t.claim_token !== token)) return false;
  const patch = {};
  if (status) patch.status = status;                 // review | blocked | done
  if (result_summary != null) patch.result_summary = result_summary;
  if (blocked_on != null) patch.blocked_on = blocked_on;
  updateTask(id, patch);
  log(id, 'report', { worker, ...patch });
  return true;
}

// Agent-a verifies a reviewed task against acceptance_criteria, then closes or bounces it back.
export function verifyTask(id, ok) {
  updateTask(id, ok
    ? { verification_status: 'verified', status: 'done' }
    : { verification_status: 'rejected', status: 'todo', claimed_by: '', claim_token: '', lease_expires_at: null });
}

// Release expired leases back to todo so the lead can reassign.
export function reapLeases() {
  return db.prepare(
    `UPDATE tasks SET status='todo', claimed_by='', claim_token='', lease_expires_at=NULL, updated_at=datetime('now')
     WHERE status='doing' AND lease_expires_at IS NOT NULL AND lease_expires_at < datetime('now')`
  ).run().changes;
}

// An agent's own queue (for the SessionStart hook).
export const agentQueue = (agent) => db.prepare(
  `SELECT * FROM tasks WHERE assignee=? AND status IN ('todo','doing','blocked') ORDER BY status, priority, rank`
).all(agent);

// Tasks awaiting the lead's verification.
export const needsReview = () => db.prepare("SELECT * FROM tasks WHERE status='review' ORDER BY updated_at DESC").all();

export default db;
