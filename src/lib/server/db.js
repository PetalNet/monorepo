import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

// Local SQLite is the source of truth (design: tracker-design-2026-05-26.md).
const DB_PATH = process.env.TASKS_DB_PATH || 'tasks.db';
try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch {}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // multi-writer safety (delegation + the Corner sync)
db.pragma('foreign_keys = ON');   // so task_blockers edges cascade when a task is deleted

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
  -- task-to-task blocking: task_id is blocked BY blocker_id. blocked_on (text) stays as a human note.
  CREATE TABLE IF NOT EXISTS task_blockers (
    task_id    INTEGER NOT NULL,
    blocker_id INTEGER NOT NULL,
    PRIMARY KEY (task_id, blocker_id),
    FOREIGN KEY (task_id)    REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (blocker_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  -- stickies: page-anchored collaborative annotations (long-press/right-click anywhere ->
  -- note pinned to a DOM element). Scoped by page_path (we have no /p/<project>/ routes),
  -- author = the signed-in Authentik user. Best-effort UI layer; ack&remove deletes.
  CREATE TABLE IF NOT EXISTS annotations (
    id              INTEGER PRIMARY KEY,
    page_path       TEXT NOT NULL,
    anchor_selector TEXT NOT NULL,
    anchor_snippet  TEXT DEFAULT '',
    anchor_offset_x REAL,
    anchor_offset_y REAL,
    body            TEXT NOT NULL,
    author          TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- artifacts / pages gallery: browsable writeups Agent-a generates (dossiers, research pages,
  -- future briefs) served INSIDE tasks behind the existing Authentik gate, instead of one-off
  -- gated subdomains (brain.example.com / tag.example.com). Content is stored IN the DB (the
  -- source of truth the container already mounts) — no on-disk file path => no path-traversal
  -- surface. kind: 'markdown' renders through renderMd (sanitized, inline .prose); 'html' is a
  -- pre-built standalone document served raw into a locked-down sandbox <iframe> (it cannot run
  -- scripts, reach the parent DOM/cookies, or make same-origin requests — see /gallery/[slug]/raw).
  -- visibility mirrors tasks: 'shared' (alice+bob) | 'private' (owner-only).
  CREATE TABLE IF NOT EXISTS artifacts (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,                 -- URL id, e.g. 'brain-dossier'
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',                       -- one-line gallery blurb
    kind        TEXT NOT NULL DEFAULT 'markdown',      -- markdown | html
    content     TEXT NOT NULL,                         -- the markdown source or full HTML document
    source      TEXT DEFAULT '',                       -- provenance, e.g. 'brain-research/DOSSIER.md'
    owner       TEXT DEFAULT '',
    visibility  TEXT NOT NULL DEFAULT 'shared',        -- shared | private
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_slug ON artifacts(slug);
  -- typed NON-blocking provenance links between tasks (fleet-dispatcher Phase 1). Distinct from
  -- task_blockers (which is the UNTYPED BLOCKING graph that gates UNBLOCKED eligibility): these
  -- carry a relationship TYPE and do NOT affect status/eligibility. First rel: 'discovered_from'
  -- (this task was discovered while working related_id). UNIQUE so re-filing the same link is a no-op.
  CREATE TABLE IF NOT EXISTS task_links (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL,           -- the task that owns the link (e.g. the newly discovered one)
    related_id INTEGER NOT NULL,           -- the other end (e.g. the parent it was discovered from)
    rel        TEXT    NOT NULL,           -- 'discovered_from' (extensible)
    created_at TEXT    DEFAULT (datetime('now')),
    UNIQUE (task_id, related_id, rel),
    FOREIGN KEY (task_id)    REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (related_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_task_links_task    ON task_links(task_id, rel);
  CREATE INDEX IF NOT EXISTS idx_task_links_related ON task_links(related_id, rel);
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
    owner: "TEXT DEFAULT ''",               // who created/owns it (authentik username; privacy)
    visibility: "TEXT DEFAULT 'shared'",    // shared | private (private = owner-only for humans)
    responsible: "TEXT DEFAULT ''",         // human accountable for completion (alice|bob); != assignee(agent)
    body_alt: "TEXT DEFAULT ''",            // "human version" — plain-english rewrite (humanize-doc skill); reader toggle + sync-safe glossary
    // Fleet/dispatcher coordination spine (Phase 1, fleet-dispatcher-proposal.md). Execution
    // HINTS for cross-machine routing — purely advisory metadata, no behavior change to the
    // board/queries. + a mandatory close-reason ledger ("git has the what, tasks has the why").
    owner_machine: "TEXT DEFAULT ''",       // which host should run it (routing hint)
    suggested_agent: "TEXT DEFAULT ''",     // recommended worker persona (routing hint)
    effort: "TEXT DEFAULT ''",              // rough size hint (e.g. xs|s|m|l)
    parallel_group: "TEXT DEFAULT ''",      // tasks in the same group may run concurrently
    close_reason: "TEXT DEFAULT ''"         // why it closed (the "why" ledger; required by the close tool/action, not yet by every status-edit path)
  };
  for (const [name, def] of Object.entries(adds)) if (!have.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${def}`);
}
ensureColumns();

// Projects also carry owner + visibility (the dropdown must not leak private project names).
function ensureProjectColumns() {
  const have = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  if (!have.has('owner')) db.exec("ALTER TABLE projects ADD COLUMN owner TEXT DEFAULT ''");
  if (!have.has('visibility')) db.exec("ALTER TABLE projects ADD COLUMN visibility TEXT DEFAULT 'shared'");
}
ensureProjectColumns();

// Indexes for the hot query paths (board lists, child fetch, events log) — the DB had none,
// so every list was a full table scan. IF NOT EXISTS = safe to run on every boot.
function ensureIndexes() {
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_upnext ON tasks(up_next)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source)',
    'CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, at)',
    'CREATE INDEX IF NOT EXISTS idx_annotations_page ON annotations(page_path)'
  ]) db.exec(sql);
}
ensureIndexes();

// Keep the audit log lean: record WHICH keys changed + small scalar values, but never
// serialize large text columns (body/body_alt/etc.) into events.data. Logging full doc
// bodies on every save had ballooned the DB to ~716MB / ~126k rows (task-340).
// trimEventData + EVENT_KEEP_PER_TASK are exported so the one-time compaction migration
// (scripts/compact-events.mjs) reuses the EXACT same rules — no drift between the
// forward fix and the backfill.
const BIG_FIELDS = new Set(['body', 'body_alt', 'acceptance_criteria', 'handoff_context', 'result_summary', 'options', 'answer', 'budget', 'context', 'plan']);
const FIELD_MAX = 200;        // any string longer than this is summarized, never stored verbatim
const EVENT_DATA_MAX = 4000;  // hard backstop on the serialized event payload (defends against
                              // nested/large structured values + high key counts trimEventData's
                              // shallow pass can't see). An oversized event is dropped to a stub.
// A summary marker we produce ourselves, e.g. "[1234 chars]" or "[omitted]". Recognizing our
// own marker makes trimEventData IDEMPOTENT (re-trimming a marker returns it unchanged) — the
// migration relies on this to reach a true fixed point.
const SUMMARY_MARKER = /^\[(?:\d+ chars|omitted)\]$/;
export function trimEventData(data) {
  if (!data || typeof data !== 'object') return data;
  const o = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && SUMMARY_MARKER.test(v)) { o[k] = v; continue; } // already summarized
    o[k] = (BIG_FIELDS.has(k) || (typeof v === 'string' && v.length > FIELD_MAX) || (v != null && typeof v === 'object'))
      ? `[${typeof v === 'string' ? v.length + ' chars' : 'omitted'}]`
      : v;
  }
  return o;
}

// Final serialization with the hard byte cap as a last line of defense: if even the trimmed
// object exceeds EVENT_DATA_MAX (pathological key counts), collapse to a tiny stub recording
// only which keys changed. Guarantees a bounded per-event payload no matter the input.
export function serializeEventData(data) {
  if (data == null) return null;
  let s = JSON.stringify(trimEventData(data));
  if (s.length > EVENT_DATA_MAX) {
    const keys = (data && typeof data === 'object') ? Object.keys(data).slice(0, 50) : [];
    s = JSON.stringify({ _truncated: true, bytes: s.length, keys });
  }
  return s;
}

// Bounding: retain at most this many events per task. The events log is an audit/history
// substrate (design: "basis for git export + future sync") with NO live app consumer, so a
// rolling window per task is safe — we keep the most recent N plus the ORIGINAL create anchor.
export const EVENT_KEEP_PER_TASK = 200;

// Prune events for ONE task down to the keep-window, atomically.
// Preserves only the EARLIEST 'create' event (the real provenance anchor) — later/duplicate
// 'create' rows are prunable like any other event, so they can't accumulate unbounded.
const pruneStmt = db.prepare(`
  DELETE FROM events
   WHERE task_id = @tid
     AND id NOT IN (
       SELECT id FROM events WHERE task_id = @tid ORDER BY id DESC LIMIT @keep
     )
     AND id != (SELECT MIN(id) FROM events WHERE task_id = @tid AND type = 'create')`);
export function pruneTaskEvents(tid, keep = EVENT_KEEP_PER_TASK) {
  if (tid == null) return 0;
  return pruneStmt.run({ tid, keep }).changes;
}

// Per-task write counter so pruning fires deterministically for EACH task (a global rowid
// modulo could starve a hot task whose ids never land on the boundary). Bounded: at most
// PRUNE_EVERY-1 events can sit above the cap between prunes. Map is process-local; that's
// fine — better-sqlite3 is single-process, and a restart just re-prunes on the next batch.
const PRUNE_EVERY = 25;
const writeCounts = new Map();
const log = (task_id, type, data) => {
  const r = db.prepare('INSERT INTO events (task_id,type,data) VALUES (?,?,?)')
    .run(task_id, type, serializeEventData(data));
  if (task_id != null) {
    const n = (writeCounts.get(task_id) || 0) + 1;
    if (n >= PRUNE_EVERY) { pruneTaskEvents(task_id); writeCounts.set(task_id, 0); }
    else writeCounts.set(task_id, n);
  }
  return r;
};

const ACTIVE = "status NOT IN ('done','dropped')";
// actionable list filter: blocked tasks get their own muted section, so the working lists hide them.
const UNBLOCKED = "status NOT IN ('done','dropped','blocked')";
const where = (p) => (p ? 'AND project_id=@p' : '');
// assignee filter: mirrors the project filter; supplied → restrict to one agent/human.
const whoFilter = (a) => (a ? 'AND assignee=@a' : '');
// visibility filter for HUMAN web views: pass the logged-in user; omit for agents (they see all).
const vis = (me) => (me ? "AND (visibility='shared' OR owner=@me)" : '');
const qargs = (p, me, a) => ({ ...(p ? { p } : {}), ...(me ? { me } : {}), ...(a ? { a } : {}) });
const args = (p) => (p ? { p } : {});

export const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);

// Write authorization for a HUMAN actor. Mirrors the read gate (vis): a private
// task is owner-only. Reads were gated but mutating actions were not (IDOR) — every
// human-facing action must call this before mutating an existing task by id.
// Missing task -> false. Shared task or your own -> true.
export function canWrite(id, me) {
  const t = db.prepare('SELECT owner, visibility FROM tasks WHERE id=?').get(id);
  if (!t) return false;
  return !(t.visibility === 'private' && t.owner && t.owner !== me);
}

// Read authorization for a HUMAN actor. Deliberately the SAME predicate as the load-gate
// in task/[id]/+page.server.js and the `vis` filter (private+owned => owner-only; everything
// else, incl. owner-less private, => visible). Kept in lockstep on purpose: a side-channel
// route (the TTS proxy) must not be able to read out a task the page would refuse, NOR
// refuse one the page would show (that would break Listen for a task you can see). Missing
// task -> false (fail closed). Only an exact 'private' visibility ever restricts.
export function canRead(id, me) {
  const t = db.prepare('SELECT owner, visibility FROM tasks WHERE id=?').get(id);
  if (!t) return false;
  return !(t.visibility === 'private' && t.owner && t.owner !== me);
}

// Strip server-only secret columns from anything bound for the browser. claim_token
// is the live lease secret claimTask/reportTask authenticate with — shipping it via
// SELECT * let any viewer hijack a worker's claim. deepScrub walks the whole load
// payload (incl. nested .kids) so callers just wrap their return value once.
const SECRET_COLS = new Set(['claim_token', 'claimed_by', 'lease_expires_at']);
export function deepScrub(v) {
  if (Array.isArray(v)) return v.map(deepScrub);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (!SECRET_COLS.has(k)) o[k] = deepScrub(v[k]);
    return o;
  }
  return v;
}

// --- task-to-task blocking ---
// A task is "blocked" iff it has >=1 blocker whose status is NOT in (done,dropped).
// me (optional) applies the same visibility gate as children()/upNext() — a private task linked
// to a shared one must NOT leak its title via the relations panel (#285/#343 class). Agent/MCP/
// internal callers pass no me and see all.
export const blockersOf = (task_id, me) => db.prepare(
  `SELECT t.* FROM task_blockers b JOIN tasks t ON t.id=b.blocker_id WHERE b.task_id=@task_id ${vis(me)} ORDER BY t.id`
).all({ task_id, ...(me ? { me } : {}) });
export const unfinishedBlockers = (task_id) => db.prepare(
  `SELECT t.* FROM task_blockers b JOIN tasks t ON t.id=b.blocker_id
   WHERE b.task_id=? AND t.status NOT IN ('done','dropped') ORDER BY t.id`
).all(task_id);
export function addBlocker(task_id, blocker_id) {
  task_id = Number(task_id); blocker_id = Number(blocker_id);
  if (!task_id || !blocker_id || task_id === blocker_id) return false; // no self-block
  db.prepare('INSERT OR IGNORE INTO task_blockers (task_id,blocker_id) VALUES (?,?)').run(task_id, blocker_id);
  log(task_id, 'add_blocker', { blocker_id });
  return true;
}
export function removeBlocker(task_id, blocker_id) {
  task_id = Number(task_id); blocker_id = Number(blocker_id);
  db.prepare('DELETE FROM task_blockers WHERE task_id=? AND blocker_id=?').run(task_id, blocker_id);
  log(task_id, 'remove_blocker', { blocker_id });
  // if it was set to 'blocked' but now has no live blockers, free it
  const t = getTask(task_id);
  if (t && t.status === 'blocked' && unfinishedBlockers(task_id).length === 0) {
    db.prepare(`UPDATE tasks SET status='todo', updated_at=datetime('now') WHERE id=?`).run(task_id);
    log(task_id, 'auto_unblock', { reason: 'blocker_removed' });
  }
  return true;
}
// Inverse blocking edge: tasks that THIS task blocks (i.e. rows where this is the blocker_id).
// Complements blockersOf (tasks that block this one). Read-only; no eligibility effect.
export const blocks = (id, me) => db.prepare(
  `SELECT t.* FROM task_blockers b JOIN tasks t ON t.id=b.task_id WHERE b.blocker_id=@id ${vis(me)} ORDER BY t.id`
).all({ id, ...(me ? { me } : {}) });

// --- typed NON-blocking provenance links (task_links) ---
// addLink: record a typed edge. Self-links and bad ids are rejected; UNIQUE makes it idempotent.
// Keeps the event payload TINY (ids + rel only, never task bodies — task-340 bloat rule).
export function addLink(task_id, related_id, rel = 'discovered_from') {
  task_id = Number(task_id); related_id = Number(related_id);
  if (!task_id || !related_id || task_id === related_id || !rel) return false;
  db.prepare('INSERT OR IGNORE INTO task_links (task_id,related_id,rel) VALUES (?,?,?)').run(task_id, related_id, rel);
  log(task_id, 'link', { related_id, rel });
  return true;
}
export const removeLink = (task_id, related_id, rel = 'discovered_from') =>
  db.prepare('DELETE FROM task_links WHERE task_id=? AND related_id=? AND rel=?').run(Number(task_id), Number(related_id), rel).changes > 0;
// discoveredFrom: the task(s) THIS one was discovered from (the parent provenance).
export const discoveredFrom = (id, me, rel = 'discovered_from') => db.prepare(
  `SELECT t.* FROM task_links l JOIN tasks t ON t.id=l.related_id WHERE l.task_id=@id AND l.rel=@rel ${vis(me)} ORDER BY t.id`
).all({ id, rel, ...(me ? { me } : {}) });
// discoveries: the task(s) discovered FROM this one (the inverse — the discovery tree's children).
export const discoveries = (id, me, rel = 'discovered_from') => db.prepare(
  `SELECT t.* FROM task_links l JOIN tasks t ON t.id=l.task_id WHERE l.related_id=@id AND l.rel=@rel ${vis(me)} ORDER BY t.id`
).all({ id, rel, ...(me ? { me } : {}) });

export const listComments = (tid) => db.prepare('SELECT * FROM comments WHERE task_id=? ORDER BY created_at').all(tid);
export function addComment(task_id, author, body) {
  const r = db.prepare('INSERT INTO comments (task_id,author,body) VALUES (?,?,?)').run(task_id, author || '', body);
  log(task_id, 'comment', { author, body });
  return Number(r.lastInsertRowid);
}
// ── stickies (page-anchored annotations) ──────────────────────────────────
export const listAnnotations = (page_path) =>
  db.prepare('SELECT * FROM annotations WHERE page_path=? ORDER BY created_at').all(page_path);
export function addAnnotation({ page_path, anchor_selector, anchor_snippet, anchor_offset_x, anchor_offset_y, body, author }) {
  const r = db.prepare(
    `INSERT INTO annotations (page_path,anchor_selector,anchor_snippet,anchor_offset_x,anchor_offset_y,body,author)
     VALUES (?,?,?,?,?,?,?)`
  ).run(page_path, anchor_selector, anchor_snippet || '', anchor_offset_x, anchor_offset_y, body, author || '');
  return db.prepare('SELECT * FROM annotations WHERE id=?').get(Number(r.lastInsertRowid));
}
export const deleteAnnotation = (id) => db.prepare('DELETE FROM annotations WHERE id=?').run(id).changes > 0;

export const listProjects = (me) => db.prepare(
  `SELECT * FROM projects ${me ? "WHERE visibility='shared' OR owner=@me" : ''} ORDER BY name`
).all(me ? { me } : {});
export const getProject = (id) => db.prepare('SELECT * FROM projects WHERE id=?').get(id);
export const renameProject = (id, name) => db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, id);
// merge a project into another: reassign its tasks to dest, then drop the now-empty source project.
// (NOT deleteProject — that deletes the tasks; here we keep them by moving them first.)
export const moveProject = db.transaction((srcId, destId) => {
  db.prepare('UPDATE tasks SET project_id=? WHERE project_id=?').run(destId, srcId);
  db.prepare('DELETE FROM projects WHERE id=?').run(srcId);
});
export const setProjectVisibility = (id, visibility, owner) => db.prepare('UPDATE projects SET visibility=?, owner=? WHERE id=?').run(visibility, owner || '', id);
export function deleteProject(id) {
  db.prepare('DELETE FROM tasks WHERE project_id=?').run(id);
  db.prepare('DELETE FROM projects WHERE id=?').run(id);
}
// one-time classify: a project with NO shared items is Alice-private (covers the Corner mirror + empty leaks)
export function classifyProjectPrivacy() {
  return db.prepare(
    `UPDATE projects SET owner='alice', visibility='private'
     WHERE visibility!='private'
       AND (SELECT count(*) FROM tasks WHERE tasks.project_id=projects.id AND tasks.visibility!='private')=0`
  ).run().changes;
}
export const getProjectByName = (name) => db.prepare('SELECT * FROM projects WHERE name=?').get(name);

// Distinct assignees present (for the UI filter dropdown). Honors the same visibility
// rule as the list views: a HUMAN only sees assignees on items they're allowed to see.
export const listAssignees = (me) => db.prepare(
  `SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL AND assignee!='' ${vis(me)} ORDER BY assignee`
).all(me ? { me } : {}).map((r) => r.assignee);

const TASKISH = "kind IN ('task','idea')"; // docs & questions are not part of the task checklist

// Top-level items per section (children render nested under their parent — work isn't flat, per Bob).
// in-progress work gets its own lane, so pull status='doing' out of up-next / to-do
export const doing   = (p, me, a) => withKids(db.prepare(`SELECT * FROM tasks WHERE status='doing' AND parent_id IS NULL AND ${TASKISH} ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY priority, updated_at DESC`).all(qargs(p, me, a)), me);
export const upNext  = (p, me, a) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=1 AND parent_id IS NULL AND ${TASKISH} AND ${UNBLOCKED} AND status!='doing' ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY rank, priority, updated_at DESC`).all(qargs(p, me, a)), me);
export const inbox   = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE kind='idea' AND status='inbox' AND parent_id IS NULL ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY created_at DESC`).all(qargs(p, me, a));
export const backlog = (p, me, a) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=0 AND parent_id IS NULL AND ${TASKISH} AND NOT (kind='idea' AND status='inbox') AND ${UNBLOCKED} AND status!='doing' ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY priority, rank, updated_at DESC`).all(qargs(p, me, a)), me);
// recently-shipped (top-level), capped — a "done" lane so the board shows momentum
export const recentDone = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE status='done' AND parent_id IS NULL AND ${TASKISH} ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY updated_at DESC LIMIT 12`).all(qargs(p, me, a));
// who's actively on something right now (incl. subtasks) — feeds the live agent rail
export const activeLeases = (me) => db.prepare(`SELECT id, title, assignee, project_id FROM tasks WHERE status='doing' AND assignee IS NOT NULL AND assignee!='' ${vis(me)} ORDER BY updated_at DESC`).all(me ? { me } : {});
// flat GitHub-style issues list — every actionable item (not docs) + its comment count, for the /issues view
export const issuesList = (me) => db.prepare(`SELECT *, (SELECT COUNT(*) FROM comments c WHERE c.task_id=tasks.id) AS ncomments FROM tasks WHERE kind != 'doc' ${vis(me)} ORDER BY priority DESC, updated_at DESC`).all(me ? { me } : {});
// /inbox (the async hub): recently-answered questions + headline counts
export const answeredQuestions = (me) => db.prepare(`SELECT * FROM tasks WHERE kind='question' AND answer IS NOT NULL AND answer!='' ${vis(me)} ORDER BY updated_at DESC LIMIT 8`).all(me ? { me } : {});
export const inboxCounts = (me) => db.prepare(`SELECT
    SUM(CASE WHEN kind='question' AND (answer IS NULL OR answer='') AND ${ACTIVE} THEN 1 ELSE 0 END) AS open,
    SUM(CASE WHEN kind='question' AND answer IS NOT NULL AND answer!='' THEN 1 ELSE 0 END) AS answered,
    SUM(CASE WHEN kind='doc' THEN 1 ELSE 0 END) AS docs,
    SUM(CASE WHEN status='doing' THEN 1 ELSE 0 END) AS doing
  FROM tasks WHERE 1=1 ${vis(me)}`).get(me ? { me } : {});
// dedicated muted section for blocked tasks (top-level only; children render under their parent).
export const blockedList = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE status='blocked' AND parent_id IS NULL AND ${TASKISH} ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY priority, rank, updated_at DESC`).all(qargs(p, me, a))
  .map((r) => ({ ...r, blockers: blockersOf(r.id, me) }));  // me-scoped: don't leak a private blocker's title on the board (#285)
// lightweight {id,title} list of open tasks for the blocker-picker dropdown (honors visibility).
export const blockerCandidates = (me) => db.prepare(
  `SELECT id, title FROM tasks WHERE ${TASKISH} AND ${ACTIVE} ${vis(me)} ORDER BY updated_at DESC LIMIT 500`
).all(me ? { me } : {});

// --- Claude Corner merge: docs (briefs/ADRs) + questions (async decisions) ---
export const listDocs = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE kind='doc' AND ${ACTIVE} ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY updated_at DESC`).all(qargs(p, me, a));
// every doc (research/briefs/ADRs) across all projects, for the /docs research library (joined → qualify cols)
export const allDocs = (me) => db.prepare(
  `SELECT t.id, t.title, t.updated_at, t.created_by, t.project_id, p.name AS project_name
   FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
   WHERE t.kind='doc' AND t.status NOT IN ('done','dropped')
   ${me ? "AND (t.visibility='shared' OR t.owner=@me)" : ''}
   ORDER BY (p.name IS NULL), p.name COLLATE NOCASE, t.updated_at DESC`
).all(me ? { me } : {});
export const openQuestions = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE kind='question' AND (answer='' OR answer IS NULL) AND ${ACTIVE} ${where(p)} ${whoFilter(a)} ${vis(me)} ORDER BY priority, created_at`).all(qargs(p, me, a));
export const answerQuestion = (id, value) => updateTask(id, { answer: value, status: 'done' });
export const createDoc = (project_id, title, body, created_by = '') => createTask({ kind: 'doc', title, body, status: 'todo', project_id, created_by });
export function createQuestion(project_id, title, context, options, created_by = '') {
  const id = createTask({ kind: 'question', title, body: context, status: 'todo', project_id, created_by });
  updateTask(id, { options: JSON.stringify(options || []) });
  return id;
}

// --- project drill-in ---
// Every visible item in one project (all kinds: task/idea/doc/question), honoring the
// same human visibility gate as the board (shared, or your own private). Flat list —
// the page groups it by status lane. Returns [] for an unknown/forbidden project.
export const tasksInProject = (pid, me) => db.prepare(
  `SELECT id, title, kind, status, priority, up_next, assignee, owner, visibility, created_at, updated_at
   FROM tasks WHERE project_id=@pid ${vis(me)} ORDER BY priority, rank, updated_at DESC`
).all({ pid, ...(me ? { me } : {}) });

// sub-task hierarchy (beads-style breakdown)
// depth-capped to survive a parent_id cycle (A->B->A) — would otherwise infinitely recurse and crash the board.
// HUMAN visibility gate: pass `me` (logged-in user) so a SHARED parent doesn't leak its
// PRIVATE children to someone who can't see them. Same rule as the board/list queries (vis):
// a human sees shared children + their own private ones; omit `me` for agents (they see all).
// Threaded recursively so it also covers sub-sub-children at every depth (task-285 / task-343).
export const children = (pid, me, depth = 0) => depth >= 8 ? [] :
  withKids(db.prepare(`SELECT * FROM tasks WHERE parent_id=@pid AND ${ACTIVE} ${vis(me)} ORDER BY rank, priority`).all({ pid, ...(me ? { me } : {}) }), me, depth);
const withKids = (rows, me, depth = 0) => rows.map((r) => ({ ...r, kids: children(r.id, me, depth + 1) }));

// The agent query (MCP get_ready, phase 2): actionable, unblocked, up-next first then by manual rank.
export const ready = (p) => db.prepare(`SELECT * FROM tasks WHERE status IN ('todo','doing') AND (blocked_on='' OR blocked_on IS NULL) ${where(p)} ORDER BY up_next DESC, rank, priority`).all(args(p));

// append to the end of the Up Next order
export const nextUpNextRank = () => (db.prepare('SELECT COALESCE(MAX(rank),0)+1 AS r FROM tasks WHERE up_next=1').get().r);

export function ensureProject(name, backend = 'local_private', opts = {}) {
  const found = getProjectByName(name);
  if (found) return found.id;
  // create-only owner/visibility: the Corner sync passes {owner:'alice',visibility:'private'}
  // so a project auto-created to hold a PRIVATE mirrored doc isn't minted 'shared' (which
  // leaked the private project name + let other users act on it). Default stays shared.
  const owner = opts.owner ?? '';
  const visibility = opts.visibility ?? 'shared';
  return Number(db.prepare('INSERT INTO projects (name,backend,owner,visibility) VALUES (?,?,?,?)')
    .run(name, backend, owner, visibility).lastInsertRowid);
}

export function createTask(t) {
  const kind = t.kind ?? 'task';
  const r = db.prepare(
    `INSERT INTO tasks (project_id,kind,title,body,status,priority,up_next,rank,parent_id,created_by,
       owner_machine,suggested_agent,effort,parallel_group)
     VALUES (@project_id,@kind,@title,@body,@status,@priority,@up_next,@rank,@parent_id,@created_by,
       @owner_machine,@suggested_agent,@effort,@parallel_group)`
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
    created_by: t.created_by ?? '',
    // fleet execution hints (advisory routing metadata) — default '' so existing callers are unaffected
    owner_machine: t.owner_machine ?? '',
    suggested_agent: t.suggested_agent ?? '',
    effort: t.effort ?? '',
    parallel_group: t.parallel_group ?? ''
  });
  const id = Number(r.lastInsertRowid);
  log(id, 'create', t);
  // typed provenance: if this task was discovered while working another, record it (non-blocking).
  if (t.discovered_from) addLink(id, t.discovered_from, 'discovered_from');
  return id;
}

const PATCHABLE = ['title', 'body', 'status', 'priority', 'up_next', 'rank', 'parent_id', 'blocked_on', 'project_id', 'kind',
  'assignee', 'capability', 'type', 'handoff_context', 'acceptance_criteria', 'result_summary', 'verification_status',
  'budget', 'max_children', 'claimed_by', 'claim_token', 'lease_expires_at', 'options', 'answer', 'source',
  'owner', 'visibility', 'responsible',
  // fleet execution hints + close-reason (Phase 1)
  'owner_machine', 'suggested_agent', 'effort', 'parallel_group', 'close_reason'];

export const getTaskBySource = (source) => db.prepare('SELECT * FROM tasks WHERE source=?').get(source);

// When a task closes, free anything it was blocking that now has no live blockers (blocked -> todo).
function cascadeUnblock(blockerId) {
  const dependents = db.prepare('SELECT task_id FROM task_blockers WHERE blocker_id=?').all(blockerId);
  for (const { task_id } of dependents) {
    const dep = getTask(task_id);
    if (dep && dep.status === 'blocked' && unfinishedBlockers(task_id).length === 0) {
      db.prepare(`UPDATE tasks SET status='todo', updated_at=datetime('now') WHERE id=?`).run(task_id);
      log(task_id, 'auto_unblock', { blocker_id: blockerId });
    }
  }
}

export const updateTask = db.transaction((id, patch) => {
  // Releasing the lease: any transition OUT of 'doing' clears the claim, so a re-opened
  // task isn't silently un-claimable behind a stale future-dated lease.
  if (patch.status && patch.status !== 'doing' && !('claim_token' in patch)) {
    patch = { ...patch, claimed_by: '', claim_token: '', lease_expires_at: null };
  }
  const cols = Object.keys(patch).filter((k) => PATCHABLE.includes(k));
  if (!cols.length) return;
  // Guard: status='blocked' requires >=1 live blocker. No-op (with a clear return) otherwise.
  if (patch.status === 'blocked' && unfinishedBlockers(id).length === 0) {
    return { ok: false, reason: 'no_blockers', message: 'Cannot set blocked: add at least one unfinished blocker first.' };
  }
  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c}=@${c}`).join(',')}, updated_at=datetime('now') WHERE id=@id`).run({ id, ...patch });
  log(id, 'update', patch);
  // Auto-unblock: closing this task frees its dependents.
  if (patch.status === 'done' || patch.status === 'dropped') cascadeUnblock(id);
  return { ok: true };
});

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

// Lockless, assignee-agnostic claim of THE next Up Next task (compare-and-set).
// Distinct from claimTask (which is scoped to a pre-assigned worker): this grabs the
// top of the Up Next queue regardless of assignee, for opportunistic workers (the MCP
// `claim` tool). The single-statement guarded UPDATE is atomic under better-sqlite3's
// single writer, so two callers can't grab the same row. Optional filters narrow the
// candidate pool. Logs a 'claim' audit event on success (parity with claimTask).
// Returns the claimed row (with its fresh claim_token) or null if nothing was free.
export const claimNext = db.transaction((worker, { project_id = null, capability = null, assignee = null } = {}) => {
  const f = [];
  const args = { worker, tok: crypto.randomUUID() };
  if (project_id != null) { f.push('AND project_id=@pid'); args.pid = project_id; }
  if (capability) { f.push('AND capability=@cap'); args.cap = capability; }
  if (assignee) { f.push('AND assignee=@asg'); args.asg = assignee; }
  // CAS + audit log run in one transaction so a claimed task always has its 'claim' event
  // (no half-state where the lease is taken but the event insert failed).
  const r = db.prepare(`
    UPDATE tasks SET status='doing', claimed_by=@worker, claim_token=@tok,
      lease_expires_at=datetime('now','+30 minutes'), updated_at=datetime('now')
    WHERE id = (SELECT id FROM tasks
                WHERE up_next=1 AND status='todo' AND kind IN ('task','idea')
                  AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))
                  ${f.join(' ')}
                ORDER BY rank, priority LIMIT 1)
    RETURNING *`).get(args);
  if (r) log(r.id, 'claim', { worker });
  return r || null;
});

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

// Close a task with a MANDATORY reason (the "why" ledger — fleet-dispatcher Phase 1).
// Stores the reason in close_reason AND emits a tiny 'closed' event {reason, by}. The new
// MCP/action paths supply a reason and the no-reason call is rejected here. Backward-compat:
// callers that genuinely can't yet supply one may pass a fallback (e.g. result_summary) so
// existing flows never break — see the MCP/actions wiring. status defaults to 'done' but
// 'dropped' is allowed (a drop is also a close-with-reason). Returns updateTask's result.
export function closeTask(id, { reason, by = '', status = 'done' } = {}) {
  reason = (reason ?? '').toString().trim();
  if (!reason) return { ok: false, reason: 'reason_required', message: 'A close reason is required.' };
  if (status !== 'done' && status !== 'dropped') status = 'done';
  // updateTask logs an 'update' event; add a dedicated tiny 'closed' event for the why-ledger.
  const res = updateTask(id, { status, close_reason: reason });
  if (res && res.ok === false) return res;            // e.g. nonexistent → no cols patched
  log(id, 'closed', { reason: reason.slice(0, 200), by });
  return res ?? { ok: true };
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

// --- artifacts / pages gallery ---------------------------------------------
// Human visibility gate, identical rule to tasks: a private artifact is owner-only.
// `me` is ALWAYS supplied for web views (the gallery has no agent API), so the gate
// is never skipped. Listing returns metadata only — never the (large) content blob.
const artVis = (me) => (me ? "WHERE (visibility='shared' OR owner=@me)" : '');
export const listArtifacts = (me) => db.prepare(
  `SELECT id, slug, title, description, kind, source, owner, visibility, created_at, updated_at
   FROM artifacts ${artVis(me)} ORDER BY updated_at DESC`
).all(me ? { me } : {});

// Fetch ONE artifact by slug, enforcing the same visibility gate in SQL. Returns
// undefined when the slug is unknown OR the caller may not see it (so callers 404
// uniformly — a private artifact never reveals its existence to an outsider).
export const getArtifact = (slug, me) => db.prepare(
  `SELECT * FROM artifacts WHERE slug=@slug ${me ? "AND (visibility='shared' OR owner=@me)" : ''}`
).get({ slug, ...(me ? { me } : {}) });

// Upsert by slug — used by the seed script and any future writer. Content stays in the DB.
export function upsertArtifact({ slug, title, description = '', kind = 'markdown', content, source = '', owner = '', visibility = 'shared' }) {
  if (!slug || !title || !content) throw new Error('artifact requires slug, title, content');
  if (kind !== 'markdown' && kind !== 'html') throw new Error('artifact kind must be markdown|html');
  // validate enum (a typo'd visibility silently becoming owner-only — or worse, "shared" by
  // accident — is an authz footgun; fail loudly instead). slug stays URL-clean.
  if (visibility !== 'shared' && visibility !== 'private') throw new Error('artifact visibility must be shared|private');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('artifact slug must be lowercase alphanumeric + dashes');
  db.prepare(
    `INSERT INTO artifacts (slug,title,description,kind,content,source,owner,visibility)
       VALUES (@slug,@title,@description,@kind,@content,@source,@owner,@visibility)
     ON CONFLICT(slug) DO UPDATE SET
       title=@title, description=@description, kind=@kind, content=@content,
       source=@source, owner=@owner, visibility=@visibility, updated_at=datetime('now')`
  ).run({ slug, title, description, kind, content, source, owner, visibility });
  return getArtifact(slug, null);
}

// An agent's own queue (for the SessionStart hook).
export const agentQueue = (agent) => db.prepare(
  `SELECT * FROM tasks WHERE assignee=? AND status IN ('todo','doing','blocked') ORDER BY status, priority, rank`
).all(agent);

// Tasks awaiting the lead's verification.
export const needsReview = () => db.prepare("SELECT * FROM tasks WHERE status='review' ORDER BY updated_at DESC").all();

export default db;
