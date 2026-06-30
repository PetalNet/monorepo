import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Local SQLite is the source of truth (design: tracker-design-2026-05-26.md).
// The default MUST be absolute, anchored to the repo's data/ dir (this module lives at
// src/lib/server/db.js → repo root is three dirs up, then data/). A bare relative 'tasks.db'
// followed the CWD, so a process started from a different directory silently opened a NEW empty
// DB and wrote there — invisible data loss (task-337). Warn when the env is unset so the
// canonical deploy path (TASKS_DB_PATH) is always explicit.
const DEFAULT_DB_PATH = resolve(fileURLToPath(import.meta.url), '../../../../data/tasks.db');
if (!process.env.TASKS_DB_PATH) console.warn(`[db] TASKS_DB_PATH unset; defaulting to ${DEFAULT_DB_PATH}`);
const DB_PATH = process.env.TASKS_DB_PATH || DEFAULT_DB_PATH;
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
    status     TEXT    NOT NULL DEFAULT 'todo',          -- inbox | todo | doing | blocked | review | done | dropped
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
  -- small key/value store. First use: events_archived_through = max events.id that has been
  -- safely written to the NAS event archive (scripts/archive-events.mjs). The in-process event
  -- pruner only deletes rows at/below this watermark, so nothing is ever dropped from the live
  -- DB before it's archived off-box (task-340: archive-to-NAS, don't lose history).
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
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
  -- scripts, reach the parent DOM/cookies, or make same-origin requests — see /gallery/[slug]/raw);
  -- 'interactive' is the same standalone-document delivery but ALLOWED to run its own JS for live
  -- demos — sandboxed allow-scripts WITHOUT allow-same-origin (opaque origin). A confidentiality
  -- cage: its JS cannot read the SSO cookie, reach the parent DOM, navigate the top frame, or make
  -- any scripted background request (default-src 'none'). The one inherent residual — a script can
  -- navigate its OWN frame out, leaking the viewer IP — is mitigated by author-only content (no user
  -- upload path), so it's as trusted as anything else Agent-a publishes. See /gallery/[slug]/raw.
  -- visibility mirrors tasks: 'shared' (alice+bob) | 'private' (owner-only).
  CREATE TABLE IF NOT EXISTS artifacts (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,                 -- URL id, e.g. 'brain-dossier'
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',                       -- one-line gallery blurb
    kind        TEXT NOT NULL DEFAULT 'markdown',      -- markdown | html | interactive
    content     TEXT NOT NULL,                         -- the markdown source or full HTML document
    source      TEXT DEFAULT '',                       -- provenance, e.g. 'brain-research/DOSSIER.md'
    owner       TEXT DEFAULT '',
    visibility  TEXT NOT NULL DEFAULT 'shared',        -- shared | private
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_slug ON artifacts(slug);
  -- scoped share-links: let someone with NO Authentik account view ONE artifact via a secret
  -- link, WITHOUT exposing anything else behind the SSO. The token itself is NEVER stored — only
  -- sha256(token) (token_hash), so a DB leak can't be replayed into working links. A row is valid
  -- iff revoked=0 AND (expires_at IS NULL OR expires_at > now). slug ties the link to exactly one
  -- artifact (the public /s/ route loads THAT slug only — it can't be coerced to another). Creation
  -- and revocation live behind the same Authentik/canWrite gate as every other mutation; the public
  -- route (Traefik-exempted from the SSO middleware for /s/ only) is strictly read-only + fail-closed.
  CREATE TABLE IF NOT EXISTS artifact_shares (
    id         INTEGER PRIMARY KEY,
    slug       TEXT NOT NULL,                         -- which artifact this link unlocks (one only)
    token_hash TEXT NOT NULL UNIQUE,                  -- sha256(token) hex; the raw token is shown ONCE on creation, never stored
    label      TEXT DEFAULT '',                       -- optional human note ("for the client demo")
    created_by TEXT DEFAULT '',                       -- authentik username that minted it (audit)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,                                  -- NULL = no expiry; else valid only while > now
    revoked    INTEGER NOT NULL DEFAULT 0             -- 1 = killed; never serves again
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_shares_token ON artifact_shares(token_hash);
  CREATE INDEX IF NOT EXISTS idx_artifact_shares_slug  ON artifact_shares(slug);
  -- mock sessions: a DECISION LAYER over the gallery (a step toward MockLab). A session poses one
  -- or more visual questions; each option POINTS AT a gallery artifact (the design). The user opens
  -- /mock/<token> and sees each option rendered in the SAME locked sandbox iframe the gallery uses —
  -- but the "Choose" controls live on the OUTER, authenticated tasks page, NEVER inside the caged
  -- iframe, so the sandbox/security model is untouched (the design can't phone home; the trusted
  -- outer page records the pick). spec/results are small agent-authored JSON blobs. token = the
  -- unguessable url id. Recording a choice is gated on an authenticated identity (fail-closed).
  -- NO per-session owner/visibility gate (unlike artifacts): any ALLOW user can read/overwrite any
  -- session by token. Intended — these are SHARED decisions between the 2 trusted users, and the
  -- token is unguessable behind SSO. If ALLOW ever grows past alice/bob, add an owner/visibility
  -- gate to getMockSession/recordMockChoice or this becomes a cross-tenant IDOR.
  CREATE TABLE IF NOT EXISTS mock_sessions (
    id          INTEGER PRIMARY KEY,
    token       TEXT NOT NULL UNIQUE,                   -- url id (crypto base64url)
    title       TEXT NOT NULL,
    spec        TEXT NOT NULL,                           -- JSON {intro?, questions:[{id,prompt,note?,options:[{key,label,slug,blurb?}]}]}
    results     TEXT NOT NULL DEFAULT '{}',              -- JSON {questionId:{choice,comment,by,at}}
    status      TEXT NOT NULL DEFAULT 'open',            -- open | resolved
    created_by  TEXT DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mock_sessions_token ON mock_sessions(token);
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
  -- Agent registry (fleet-dispatcher, #212). The authoritative list of which agents exist and
  -- — critically — what each MAY work. Today lane/capability routing is purely ADVISORY (the
  -- suggested_agent / owner_machine / capability HINTS on a task). This table is the ENFORCED
  -- side: claimNextForAgent / assignTaskToAgent look an agent's capabilities up HERE, server-side
  -- (the agent never supplies its own filter), so an out-of-lane agent is blocked by the DB, not
  -- by politely asking the model. lane is a coarse human label (open|work|lab|...); the real
  -- gate is capabilities (a CSV of tags) checked against a task's capability tag in agentCan().
  -- autonomy (auto|ask|readonly|paused) is advisory today except 'paused'/inactive, which the
  -- claim/assign paths treat as "can work nothing". Idempotent create — see ensureAgentsTable too.
  CREATE TABLE IF NOT EXISTS agents (
    handle       TEXT PRIMARY KEY,                         -- canonical lowercase id (e.g. 'person-c')
    display_name TEXT    DEFAULT '',
    host         TEXT    DEFAULT '',                       -- which machine it runs on (advisory)
    role         TEXT    DEFAULT '',                       -- free-text role label
    lane         TEXT    DEFAULT 'open',                   -- coarse lane label (advisory; capabilities is the gate)
    capabilities TEXT    DEFAULT '',                       -- CSV of capability tags it MAY work (the lane gate)
    autonomy     TEXT    DEFAULT 'ask',                    -- auto | ask | readonly | paused
    active       INTEGER NOT NULL DEFAULT 1,               -- 0 = retired/disabled → claims nothing
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Agent-registry columns (additive, for a DB that predates the table). Mirrors ensureColumns'
// idempotent ALTER pattern + the duplicate-column swallow so two booting processes can't race it.
function ensureAgentsTable() {
  const have = new Set(db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name));
  const adds = {
    display_name: "TEXT DEFAULT ''",
    host: "TEXT DEFAULT ''",
    role: "TEXT DEFAULT ''",
    lane: "TEXT DEFAULT 'open'",
    capabilities: "TEXT DEFAULT ''",
    autonomy: "TEXT DEFAULT 'ask'",
    active: 'INTEGER NOT NULL DEFAULT 1',
    created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
    updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))"
  };
  for (const [name, def] of Object.entries(adds)) if (!have.has(name)) {
    try { db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${def}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}
ensureAgentsTable();

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
    close_reason: "TEXT DEFAULT ''",        // why it closed (the "why" ledger; required by the close tool/action, not yet by every status-edit path)
    synced_snapshot: "TEXT DEFAULT ''"      // JSON of the fields the Corner mirror last wrote — the 3-way-merge base so a re-sync never clobbers a local edit (task-346)
  };
  // try/catch: two processes booting at once (server + sync cron) can both read `have`
  // before either adds the column, then race the ALTER — the loser throws "duplicate column".
  // Swallow only that; anything else is a real error.
  for (const [name, def] of Object.entries(adds)) if (!have.has(name)) {
    try { db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${def}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}
ensureColumns();

// Projects also carry owner + visibility (the dropdown must not leak private project names).
function ensureProjectColumns() {
  const have = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  if (!have.has('owner')) db.exec("ALTER TABLE projects ADD COLUMN owner TEXT DEFAULT ''");
  if (!have.has('visibility')) db.exec("ALTER TABLE projects ADD COLUMN visibility TEXT DEFAULT 'shared'");
  if (!have.has('archived_at')) db.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
}
ensureProjectColumns();

// Indexes for the hot query paths (board lists, child fetch, events log) — the DB had none,
// so every list was a full table scan. IF NOT EXISTS = safe to run on every boot.
function ensureIndexes() {
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)',
    // composite: the board sections filter parent_id (NULL for top-level, NOT NULL for the
    // child-map preload) together with status — one index serves both (task-280 N+1 work).
    'CREATE INDEX IF NOT EXISTS idx_tasks_parent_status ON tasks(parent_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_upnext ON tasks(up_next)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source)',
    // assignee: board lanes + listAssignees/activeLeases/MCP filters all do `WHERE assignee=?`
    // (whoFilter); kind: issuesList/listDocs/allDocs filter `kind IN (...)` (task-280 audit).
    'CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)',
    'CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, at)',
    'CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type, at)',  // board: closedToday + closed ledger
    'CREATE INDEX IF NOT EXISTS idx_annotations_page ON annotations(page_path)',
    // blocker_id-leading lookups (cascadeUnblock, blocks(), removeBlocker) aren't covered by the
    // task_blockers PK (task_id, blocker_id), so index the reverse direction (task-280 audit).
    'CREATE INDEX IF NOT EXISTS idx_blockers_blocker ON task_blockers(blocker_id)'
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

// Archive watermark: the max events.id written to the NAS archive (scripts/archive-events.mjs).
// The pruner NEVER deletes an event above this, so the live DB only ever sheds rows already
// preserved off-box. With watermark 0 (archiver never ran) the pruner deletes NOTHING — the
// safe default (events accumulate, slim, until the nightly archiver advances the watermark).
const _wmGet = db.prepare("SELECT value FROM meta WHERE key='events_archived_through'");
// Monotonic: the watermark can only move FORWARD (guards against a late/overlapping writer
// moving it backward, which would re-expose archived rows to re-pruning churn).
const _wmSet = db.prepare(
  "INSERT INTO meta (key,value) VALUES ('events_archived_through',@v) " +
  "ON CONFLICT(key) DO UPDATE SET value=@v WHERE CAST(@v AS INTEGER) > CAST(value AS INTEGER)");
export function getArchiveWatermark() { const r = _wmGet.get(); return r ? (Number(r.value) || 0) : 0; }
export function setArchiveWatermark(id) { _wmSet.run({ v: String(Number(id) || 0) }); return getArchiveWatermark(); }

// Prune ONE task's events down to the keep-window, atomically — but ONLY rows at/below the
// archive watermark (already on the NAS). Preserves the EARLIEST 'create' anchor; later/dup
// 'create' rows are prunable like any other event so they can't accumulate unbounded.
const pruneStmt = db.prepare(`
  DELETE FROM events
   WHERE task_id = @tid
     AND id <= @wm
     AND id NOT IN (
       SELECT id FROM events WHERE task_id = @tid ORDER BY id DESC LIMIT @keep
     )
     AND id != (SELECT MIN(id) FROM events WHERE task_id = @tid AND type = 'create')`);
export function pruneTaskEvents(tid, keep = EVENT_KEEP_PER_TASK) {
  if (tid == null) return 0;
  return pruneStmt.run({ tid, keep, wm: getArchiveWatermark() }).changes;
}

// --- helpers for the NAS event archiver (scripts/archive-events.mjs) — kept here so the
// archive/reclaim path shares this module's connection (WAL, busy_timeout) and never forks a
// divergent second code path (the task-284 lesson). ---
// A batch of events strictly above `afterId`, oldest-first (id cursor → bounded memory on the
// big first run). Selected columns ARE the archive record.
export const eventsBatchAfter = (afterId, limit) =>
  db.prepare('SELECT id, task_id, type, data, at FROM events WHERE id > ? ORDER BY id ASC LIMIT ?').all(afterId, limit);
export const maxEventId = () => db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM events').get().m;
export const eventCount = () => db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
// distinct task_ids that currently have events (so the archiver can prune each to its window).
export const eventTaskIds = () =>
  db.prepare('SELECT DISTINCT task_id FROM events WHERE task_id IS NOT NULL').all().map((r) => r.task_id);
// Full VACUUM to return freed pages to the filesystem (reclaim). Heavy + needs a write lock;
// busy_timeout (5s) covers the low-traffic tracker. Called explicitly by the archiver's
// --vacuum path, never on a normal write.
export const vacuumDb = () => { db.exec('VACUUM'); };

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
// archive: a project with archived_at SET is hidden from every ACTIVE task view (restorable).
// NULL-project guard: bare `project_id NOT IN (subq)` would drop NULL-project tasks (NULL NOT IN => NULL).
const NOTARCHIVED = "AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))";

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

// Strip the ONE server-only secret from anything bound for the browser: claim_token.
// It's the live lease capability claimTask/reportTask authenticate with — shipping it
// via SELECT * would let any viewer hijack a worker's claim. claimed_by and
// lease_expires_at are NOT secrets: knowing either enables no action without the token,
// so they ship to the UI on purpose — claimed_by drives the fleet board's agent
// swimlanes, lease_expires_at the lease-age / countdown display. deepScrub walks the
// whole payload (incl. nested .kids / lanes) so callers just wrap their return once.
const SECRET_COLS = new Set(['claim_token']);
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
  `SELECT t.* FROM task_blockers b JOIN tasks t ON t.id=b.blocker_id WHERE b.task_id=@task_id ${vis(me)} ${NOTARCHIVED} ORDER BY t.id`
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
  `SELECT t.* FROM task_blockers b JOIN tasks t ON t.id=b.task_id WHERE b.blocker_id=@id ${vis(me)} ${NOTARCHIVED} ORDER BY t.id`
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
  `SELECT t.* FROM task_links l JOIN tasks t ON t.id=l.related_id WHERE l.task_id=@id AND l.rel=@rel ${vis(me)} ${NOTARCHIVED} ORDER BY t.id`
).all({ id, rel, ...(me ? { me } : {}) });
// discoveries: the task(s) discovered FROM this one (the inverse — the discovery tree's children).
export const discoveries = (id, me, rel = 'discovered_from') => db.prepare(
  `SELECT t.* FROM task_links l JOIN tasks t ON t.id=l.task_id WHERE l.related_id=@id AND l.rel=@rel ${vis(me)} ${NOTARCHIVED} ORDER BY t.id`
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
  `SELECT * FROM projects WHERE archived_at IS NULL ${me ? "AND (visibility='shared' OR owner=@me)" : ''} ORDER BY name`
).all(me ? { me } : {});
// archive / restore a whole project: archived tasks vanish from active views (via NOTARCHIVED), nothing deleted.
export const archiveProject = (name) => db.prepare("UPDATE projects SET archived_at=datetime('now') WHERE name=? AND archived_at IS NULL").run(name);
export const unarchiveProject = (name) => db.prepare('UPDATE projects SET archived_at=NULL WHERE name=?').run(name);
export const listArchivedProjects = () => db.prepare('SELECT * FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').all();
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
  `SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL AND assignee!='' ${vis(me)} ${NOTARCHIVED} ORDER BY assignee`
).all(me ? { me } : {}).map((r) => r.assignee);

const TASKISH = "kind IN ('task','idea')"; // docs & questions are not part of the task checklist

// Top-level items per section (children render nested under their parent — work isn't flat, per Bob).
// in-progress work gets its own lane, so pull status='doing' out of up-next / to-do
export const doing   = (p, me, a) => withKids(db.prepare(`SELECT * FROM tasks WHERE status='doing' AND parent_id IS NULL AND ${TASKISH} ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY priority, updated_at DESC`).all(qargs(p, me, a)), me);
export const upNext  = (p, me, a) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=1 AND parent_id IS NULL AND ${TASKISH} AND ${UNBLOCKED} AND status!='doing' ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY rank, priority, updated_at DESC`).all(qargs(p, me, a)), me);
export const inbox   = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE kind='idea' AND status='inbox' AND parent_id IS NULL ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY created_at DESC`).all(qargs(p, me, a));
export const backlog = (p, me, a) => withKids(db.prepare(`SELECT * FROM tasks WHERE up_next=0 AND parent_id IS NULL AND ${TASKISH} AND NOT (kind='idea' AND status='inbox') AND ${UNBLOCKED} AND status!='doing' ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY priority, rank, updated_at DESC`).all(qargs(p, me, a)), me);
// recently-shipped (top-level), capped — a "done" lane so the board shows momentum
export const recentDone = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE status='done' AND parent_id IS NULL AND ${TASKISH} ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY updated_at DESC LIMIT 12`).all(qargs(p, me, a));
// global title/body search (the top-bar search box). Visibility-gated like every list, open items
// first then done, dropped excluded. LIKE wildcards in the user's term are escaped so a literal
// '%' or '_' matches itself. Capped — this is a quick jump-to, not a report.
export const searchTasks = (q, me) => {
  const term = `%${String(q || '').replace(/[\\%_]/g, '\\$&')}%`;
  const params = { q: term };
  if (me) params.me = me;
  return db.prepare(
    `SELECT id, title, kind, status, priority, project_id, assignee, owner, visibility, updated_at
       FROM tasks
      WHERE status != 'dropped'
        AND (title LIKE @q ESCAPE '\\' OR body LIKE @q ESCAPE '\\')
        ${vis(me)} ${NOTARCHIVED}
      ORDER BY (status='done') ASC, priority, updated_at DESC
      LIMIT 60`
  ).all(params);
};

// Lightweight client-side search index — the WHOLE visible corpus (id/title/state/
// project/assignee), fetched once on first focus and fuzzy-ranked in the browser for
// instant typeahead. Visibility-gated; capped so a runaway corpus can't blow the payload.
export const searchIndex = (me) => db.prepare(
  `SELECT t.id, t.title, t.kind, t.status, t.priority, t.assignee, t.updated_at,
          (SELECT name FROM projects p WHERE p.id = t.project_id) AS project
     FROM tasks t
    WHERE t.status != 'dropped' ${vis(me)} ${NOTARCHIVED}
    ORDER BY (t.status='done') ASC, t.updated_at DESC
    LIMIT 2000`
).all(me ? { me } : {});
// who's actively on something right now (incl. subtasks) — feeds the live agent rail
export const activeLeases = (me) => db.prepare(`SELECT id, title, assignee, project_id FROM tasks WHERE status='doing' AND assignee IS NOT NULL AND assignee!='' ${vis(me)} ${NOTARCHIVED} ORDER BY updated_at DESC`).all(me ? { me } : {});
// flat GitHub-style issues list — every actionable item (not docs) + its comment count, for the /issues view
export const issuesList = (me) => db.prepare(`SELECT *, (SELECT COUNT(*) FROM comments c WHERE c.task_id=tasks.id) AS ncomments FROM tasks WHERE kind != 'doc' ${vis(me)} ${NOTARCHIVED} ORDER BY priority DESC, updated_at DESC`).all(me ? { me } : {});
// /inbox (the async hub): recently-answered questions + headline counts
export const answeredQuestions = (me) => db.prepare(`SELECT * FROM tasks WHERE kind='question' AND answer IS NOT NULL AND answer!='' ${vis(me)} ${NOTARCHIVED} ORDER BY updated_at DESC LIMIT 8`).all(me ? { me } : {});
export const inboxCounts = (me) => db.prepare(`SELECT
    SUM(CASE WHEN kind='question' AND (answer IS NULL OR answer='') AND ${ACTIVE} THEN 1 ELSE 0 END) AS open,
    SUM(CASE WHEN kind='question' AND answer IS NOT NULL AND answer!='' THEN 1 ELSE 0 END) AS answered,
    SUM(CASE WHEN kind='doc' THEN 1 ELSE 0 END) AS docs,
    SUM(CASE WHEN status='doing' THEN 1 ELSE 0 END) AS doing
  FROM tasks WHERE 1=1 ${vis(me)} ${NOTARCHIVED}`).get(me ? { me } : {});
// dedicated muted section for blocked tasks (top-level only; children render under their parent).
// blockers are fetched in ONE batched query (was a per-row blockersOf() call = N+1). me-scoped
// vis so a private blocker's title never leaks on the board (#285); order matches blockersOf (t.id).
export const blockedList = (p, me, a) => {
  const rows = db.prepare(`SELECT * FROM tasks WHERE status='blocked' AND parent_id IS NULL AND ${TASKISH} ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY priority, rank, updated_at DESC`).all(qargs(p, me, a));
  if (!rows.length) return rows;
  const idp = {}; rows.forEach((r, i) => { idp['t' + i] = r.id; });
  const placeholders = rows.map((_, i) => '@t' + i).join(',');
  const edges = db.prepare(
    `SELECT b.task_id AS _owner, t.* FROM task_blockers b JOIN tasks t ON t.id=b.blocker_id
      WHERE b.task_id IN (${placeholders}) ${vis(me)} ${NOTARCHIVED} ORDER BY t.id`
  ).all({ ...idp, ...(me ? { me } : {}) });
  const byOwner = new Map();
  for (const e of edges) {
    const owner = e._owner; delete e._owner;
    const arr = byOwner.get(owner); if (arr) arr.push(e); else byOwner.set(owner, [e]);
  }
  return rows.map((r) => ({ ...r, blockers: byOwner.get(r.id) || [] }));
};
// lightweight {id,title} list of open tasks for the blocker-picker dropdown (honors visibility).
export const blockerCandidates = (me) => db.prepare(
  `SELECT id, title FROM tasks WHERE ${TASKISH} AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED} ORDER BY updated_at DESC LIMIT 500`
).all(me ? { me } : {});

// --- Claude Corner merge: docs (briefs/ADRs) + questions (async decisions) ---
export const listDocs = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE kind='doc' AND ${ACTIVE} ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY updated_at DESC`).all(qargs(p, me, a));
// every doc (research/briefs/ADRs) across all projects, for the /docs research library (joined → qualify cols)
export const allDocs = (me) => db.prepare(
  `SELECT t.id, t.title, t.updated_at, t.created_by, t.project_id, p.name AS project_name
   FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
   WHERE t.kind='doc' AND t.status NOT IN ('done','dropped')
   ${me ? "AND (t.visibility='shared' OR t.owner=@me)" : ''}
   ORDER BY (p.name IS NULL), p.name COLLATE NOCASE, t.updated_at DESC`
).all(me ? { me } : {});
export const openQuestions = (p, me, a) => db.prepare(`SELECT * FROM tasks WHERE kind='question' AND (answer='' OR answer IS NULL) AND ${ACTIVE} ${where(p)} ${whoFilter(a)} ${vis(me)} ${NOTARCHIVED} ORDER BY priority, created_at`).all(qargs(p, me, a));
// Answer a question: only valid for kind='question', and an empty answer is rejected (an
// empty value would otherwise mark the question done with no recorded decision). task-302.
export function answerQuestion(id, value) {
  if (value == null || String(value).trim() === '') return { ok: false, reason: 'empty_answer', message: 'An answer value is required.' };
  const t = getTask(id);
  if (!t || t.kind !== 'question') return { ok: false, reason: 'not_a_question', message: 'answerQuestion only applies to kind=question.' };
  return updateTask(id, { answer: value, status: 'done' });
}
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
   FROM tasks WHERE project_id=@pid ${vis(me)} ${NOTARCHIVED} ORDER BY priority, rank, updated_at DESC`
).all({ pid, ...(me ? { me } : {}) });

// sub-task hierarchy (beads-style breakdown). HUMAN visibility gate: pass `me` so a SHARED
// parent doesn't leak its PRIVATE children to someone who can't see them (same `vis` rule as
// the board/list queries); omit `me` for agents (they see all). Covers sub-sub-children at
// every depth (task-285 / task-343), depth-capped at 8 to survive a parent_id cycle (A->B->A)
// which would otherwise recurse forever and crash the board.
//
// PERF (task-280): this used to be a mutually-recursive pair that fired ONE query PER node,
// so rendering the board was O(active tasks) round-trips (the documented N+1). Now it's a
// SINGLE query for all visible active children grouped by parent_id, then pure in-memory
// subtree assembly — one DB hit regardless of tree size/shape.
function childMapByParent(me) {
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE parent_id IS NOT NULL AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED} ORDER BY rank, priority`
  ).all(me ? { me } : {});
  const m = new Map();
  for (const r of rows) {
    const arr = m.get(r.parent_id);
    if (arr) arr.push(r); else m.set(r.parent_id, [r]);
  }
  return m;
}
// Assemble subtrees for `rows` from a preloaded parent->children map (no DB). Depth-capped
// at 8 levels deep (rows at depth 0..7; depth-7 nodes get no kids) — exactly the prior
// recursion's cap, which guards against a parent_id cycle (A->B->A) recursing forever.
const attachKids = (rows, map, depth = 0) =>
  rows.map((r) => ({ ...r, kids: depth >= 7 ? [] : attachKids(map.get(r.id) || [], map, depth + 1) }));
// Top-level rows + their full (visible, active) subtrees — one preload, then assemble.
const withKids = (rows, me) => (rows.length ? attachKids(rows, childMapByParent(me)) : rows);
// One task's children + descendants (the task/[id] relations panel). Same one-query model.
export const children = (pid, me) => {
  const roots = db.prepare(
    `SELECT * FROM tasks WHERE parent_id=@pid AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED} ORDER BY rank, priority`
  ).all({ pid, ...(me ? { me } : {}) });
  return roots.length ? attachKids(roots, childMapByParent(me)) : roots;
};

// Sub-tasks for the detail page hierarchy section: ALL statuses (incl. done/dropped) so a
// completed child still shows under its parent — distinct from children() above, which is the
// board's ACTIVE-only roll-up. Visibility-gated; flat (one level — the detail page links down).
export const childrenAll = (pid, me) => db.prepare(
  `SELECT id, title, kind, status, priority, assignee FROM tasks
   WHERE parent_id=@pid ${vis(me)} ${NOTARCHIVED} ORDER BY rank, priority, id`
).all({ pid, ...(me ? { me } : {}) });

// The parent row (for the "↳ part of #parent" up-link), visibility-gated so a private parent
// isn't revealed under a shared child. Returns the minimal columns the link needs, or null.
export const parentOf = (childId, me) => {
  const c = db.prepare('SELECT parent_id FROM tasks WHERE id=?').get(childId);
  if (!c || !c.parent_id) return null;
  return db.prepare(
    `SELECT id, title, status FROM tasks WHERE id=@pid ${vis(me)} ${NOTARCHIVED}`
  ).get({ pid: c.parent_id, ...(me ? { me } : {}) }) || null;
};

// Chronological activity feed for the detail-page timeline: the task's audit events
// (create / update / claim / report / closed …). Bounded — the per-task pruner keeps the
// most recent EVENT_KEEP_PER_TASK, and this is purely display, so an unbounded scan never
// happens. data is the serialized JSON payload (parsed best-effort in the loader).
export const taskEvents = (tid) => db.prepare(
  'SELECT id, type, data, at FROM events WHERE task_id=? ORDER BY id'
).all(tid);

// The agent query (MCP get_ready, phase 2): actionable, unblocked, up-next first then by manual rank.
export const ready = (p) => db.prepare(`SELECT * FROM tasks WHERE status IN ('todo','doing') AND (blocked_on='' OR blocked_on IS NULL) ${where(p)} ${NOTARCHIVED} ORDER BY up_next DESC, rank, priority`).all(args(p));

// append to the end of the Up Next order — scoped to ACTIVE rows so a closed (done/dropped)
// task's stale rank can't push the next item's rank arbitrarily high and break manual ordering (task-323).
export const nextUpNextRank = () => (db.prepare(`SELECT COALESCE(MAX(rank),0)+1 AS r FROM tasks WHERE up_next=1 AND ${ACTIVE}`).get().r);

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

// Default home for tasks filed without an explicit project (task-192). Rather than
// erroring on a floating task (which would block the capture path), unparented work
// lands in a single, sane catch-all project so nothing goes truly orphaned. Lazily
// created on first use; safe/reversible (just another shared project).
export const DEFAULT_PROJECT = 'inbox';
export const defaultProjectId = () => ensureProject(DEFAULT_PROJECT);

export function createTask(t) {
  const kind = t.kind ?? 'task';
  // INVARIANT (Bob, corrected repeatedly — do NOT let this regress again): a real TASK must have a
  // parent project. Enforced HERE, the single helper every create path funnels through (web /new,
  // MCP file, triage, subtask), so no UI layer can quietly re-introduce project-less tasks. Ideas,
  // docs and questions may be project-less pre-triage; only kind='task' is gated.
  const _pid = (t.project_id && typeof t.project_id === 'object') ? t.project_id.id : (t.project_id ?? null);
  if (kind === 'task' && !_pid) throw new Error('A task must have a parent project (project_id is required).');
  const r = db.prepare(
    `INSERT INTO tasks (project_id,kind,title,body,status,priority,up_next,rank,parent_id,created_by,
       owner_machine,suggested_agent,effort,parallel_group)
     VALUES (@project_id,@kind,@title,@body,@status,@priority,@up_next,@rank,@parent_id,@created_by,
       @owner_machine,@suggested_agent,@effort,@parallel_group)`
  ).run({
    project_id: _pid,
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
  // INVARIANT (Bob): a TASK must have a parent project. Block any update that turns this into a
  // kind=task while it has no project — e.g. triaging a project-less inbox idea straight to a task.
  // Mirrors the createTask guard so the triage path can't sneak a project-less task in either.
  if (patch.kind === 'task') {
    const pid = ('project_id' in patch) ? patch.project_id : db.prepare('SELECT project_id FROM tasks WHERE id=?').get(id)?.project_id;
    if (!pid) return { ok: false, reason: 'no_project', message: 'Cannot make this a task without a parent project — set a project first.' };
  }
  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c}=@${c}`).join(',')}, updated_at=datetime('now') WHERE id=@id`).run({ id, ...patch });
  log(id, 'update', patch);
  // Auto-unblock: closing this task frees its dependents.
  if (patch.status === 'done' || patch.status === 'dropped') cascadeUnblock(id);
  return { ok: true };
});

// Corner-mirror bookkeeping: records the field values the mirror last wrote, used as the
// 3-way-merge base in sync-corner.mjs (task-346). Deliberately a raw write — it must NOT log
// an event or bump updated_at, since it's invisible internal state, not a user-visible change.
export const setSyncSnapshot = (id, snapshot) =>
  db.prepare('UPDATE tasks SET synced_snapshot=? WHERE id=?').run(snapshot, id);

// Run fn as a single IMMEDIATE transaction (takes the write lock up front). The Corner mirror
// uses this to do its read → 3-way-compare → patch → snapshot-advance atomically: the row is
// re-read INSIDE the txn, so a human edit can't land between the read and the write and get
// clobbered from a stale snapshot (task-346, the stale-read race).
export const withTxn = (fn) => db.transaction(fn).immediate();

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

// --- agent registry + ENFORCED lane/capability routing (fleet-dispatcher, #212) ---
// The gap this closes: lane/capability routing was ADVISORY (suggested_agent/capability HINTS).
// Nothing stopped an out-of-lane agent (e.g. 'person-c', work-only) from claiming a lab task. These
// functions make the lane a gate the DISPATCHER enforces server-side: an agent's capabilities are
// looked up HERE, never trusted from the caller, so the agent cannot widen its own pool.

// Normalize a handle to the canonical key (lowercase, trimmed). Mirrors fleet.js, which lowercases
// handles read off the status files — keep the registry key in lockstep so lookups always hit.
const normHandle = (h) => String(h ?? '').trim().toLowerCase();
// Parse a CSV capability set → lowercase, trimmed, de-duped, empties dropped. Tolerant of the
// free-text column (spaces, trailing commas, mixed case). Used for both agent.capabilities and
// (degenerately) a task's single capability tag.
const capSet = (csv) => new Set(
  String(csv ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// Insert-or-update one agent by handle. Only the fields PRESENT in the arg are written on update
// (so a partial upsert — e.g. just flipping autonomy — doesn't wipe capabilities). updated_at is
// always bumped. active accepts a bool/0/1; an explicit value wins, else defaults to 1 on insert.
// Returns the stored row.
export function upsertAgent({ handle, display_name, host, role, lane, capabilities, autonomy, active } = {}) {
  const h = normHandle(handle);
  if (!h) throw new Error('upsertAgent requires a handle');
  const existing = db.prepare('SELECT * FROM agents WHERE handle=?').get(h);
  // coalesce: present-in-arg → use it; else keep existing; else the column default.
  const pick = (val, cur, def) => (val !== undefined ? val : (existing ? cur : def));
  const row = {
    handle: h,
    display_name: pick(display_name, existing?.display_name, ''),
    host: pick(host, existing?.host, ''),
    role: pick(role, existing?.role, ''),
    lane: pick(lane, existing?.lane, 'open'),
    capabilities: pick(capabilities, existing?.capabilities, ''),
    autonomy: pick(autonomy, existing?.autonomy, 'ask'),
    // active: normalize any truthy/0/1/false to an integer; default active on first insert.
    active: (active !== undefined ? (active ? 1 : 0) : (existing ? existing.active : 1))
  };
  db.prepare(
    `INSERT INTO agents (handle,display_name,host,role,lane,capabilities,autonomy,active)
       VALUES (@handle,@display_name,@host,@role,@lane,@capabilities,@autonomy,@active)
     ON CONFLICT(handle) DO UPDATE SET
       display_name=@display_name, host=@host, role=@role, lane=@lane,
       capabilities=@capabilities, autonomy=@autonomy, active=@active,
       updated_at=datetime('now')`
  ).run(row);
  return getAgent(h);
}

export const listAgents = () => db.prepare('SELECT * FROM agents ORDER BY handle').all();
export const getAgent = (handle) => db.prepare('SELECT * FROM agents WHERE handle=?').get(normHandle(handle));
export const setAgentActive = (handle, on) =>
  db.prepare("UPDATE agents SET active=@a, updated_at=datetime('now') WHERE handle=@h")
    .run({ h: normHandle(handle), a: on ? 1 : 0 }).changes > 0;

// THE LANE GATE. true iff `agent` (by handle) may work `task`. Rules:
//   * unknown agent OR active=0 → false (a ghost/retired agent works nothing).
//   * task.capability === '' (or null) → OPEN: any active agent may work it.
//   * else the task's single capability tag MUST be in the agent's capabilities set.
// The agent's capabilities come from the REGISTRY, never the caller — that's the enforcement:
// give 'person-c' capabilities WITHOUT 'lab', tag lab tasks capability='lab' → person-c is blocked here.
// Accepts a task row OR a bare task id (re-read for the latter). A missing task → false.
export function agentCan(handle, task) {
  const agent = getAgent(handle);
  if (!agent || !agent.active) return false;
  const t = (task && typeof task === 'object') ? task : getTask(task);
  if (!t) return false;
  const need = String(t.capability ?? '').trim().toLowerCase();
  if (!need) return true;                       // OPEN task → anyone active
  return capSet(agent.capabilities).has(need);  // gated task → must hold the tag
}

// Atomic, lane-bounded claim of the next Up Next task THIS agent may work. Like claimNext, but the
// candidate pool is filtered by the agent's REGISTERED capabilities (looked up server-side — the
// agent does NOT pass its own filter, the whole point). Inactive/paused agent → claims nothing.
// Same single-statement guarded UPDATE under better-sqlite3's single writer → no double-claim; sets
// the 30-min lease + logs the 'claim' event. Returns the claimed row (with its fresh token) or null.
export const claimNextForAgent = db.transaction((handle, { project_id = null } = {}) => {
  const agent = getAgent(handle);
  if (!agent || !agent.active || agent.autonomy === 'paused') return null;
  const caps = capSet(agent.capabilities);
  const args = { worker: agent.handle, tok: crypto.randomUUID() };
  const f = [];
  if (project_id != null) { f.push('AND project_id=@pid'); args.pid = project_id; }
  // The lane gate, IN SQL: a candidate is eligible iff its capability is empty (OPEN) OR the
  // (lowercased) tag is one this agent holds. We can't bind a SQL "IN (set)" of arbitrary size
  // cleanly across drivers, so enumerate the agent's tags as @c0,@c1,...; an agent with NO caps
  // can still take OPEN tasks (the empty-capability branch). Comparison is lowercased both sides.
  const capParams = [];
  let i = 0;
  for (const c of caps) { const k = 'c' + i++; args[k] = c; capParams.push('@' + k); }
  const capPred = capParams.length
    ? `AND (capability='' OR capability IS NULL OR lower(trim(capability)) IN (${capParams.join(',')}))`
    : `AND (capability='' OR capability IS NULL)`;
  const r = db.prepare(`
    UPDATE tasks SET status='doing', claimed_by=@worker, claim_token=@tok,
      lease_expires_at=datetime('now','+30 minutes'), updated_at=datetime('now')
    WHERE id = (SELECT id FROM tasks
                WHERE up_next=1 AND status='todo' AND kind IN ('task','idea')
                  AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))
                  ${capPred}
                  ${f.join(' ')}
                ORDER BY rank, priority LIMIT 1)
    RETURNING *`).get(args);
  if (r) log(r.id, 'claim', { worker: agent.handle, via: 'claimNextForAgent' });
  return r || null;
});

// Mayor push-assignment WITH the lane gate. Validates agentCan() FIRST; rejects an out-of-lane (or
// unknown/inactive) agent with {ok:false,reason} instead of routing work it can't do. On success,
// reuses assignTask (assignee + status='todo'). Returns {ok:true,...} or {ok:false,reason,message}.
export function assignTaskToAgent(id, handle) {
  const h = normHandle(handle);
  const t = getTask(id);
  if (!t) return { ok: false, reason: 'no_task', message: `No task #${id}.` };
  const agent = getAgent(h);
  if (!agent) return { ok: false, reason: 'unknown_agent', message: `No registered agent '${h}'.` };
  if (!agent.active) return { ok: false, reason: 'inactive_agent', message: `Agent '${h}' is inactive.` };
  if (!agentCan(h, t)) {
    return { ok: false, reason: 'out_of_lane',
      message: `Agent '${h}' may not work capability='${t.capability || ''}' (lane gate).` };
  }
  assignTask(id, agent.handle, undefined); // keep the task's existing capability tag
  return { ok: true, id: Number(id), assignee: agent.handle };
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
  if (kind !== 'markdown' && kind !== 'html' && kind !== 'interactive') throw new Error('artifact kind must be markdown|html|interactive');
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

// --- mock sessions (decision layer over the gallery) -----------------------
// A session poses visual questions whose options point at gallery artifacts. The picker UI
// (the choose buttons) lives on the OUTER authenticated tasks page; the designs stay caged in
// the gallery sandbox. createMockSession is author-side (Agent-a); recordMockChoice is the gated
// write the picker page calls. me is ALWAYS required to record (fail-closed).
export function createMockSession({ title, spec, created_by = '' }) {
  if (!title || !spec) throw new Error('mock session requires title, spec');
  const specObj = typeof spec === 'string' ? JSON.parse(spec) : spec;
  if (!Array.isArray(specObj.questions) || !specObj.questions.length) throw new Error('spec needs questions[]');
  for (const q of specObj.questions) {
    if (!q.id || !q.prompt || !Array.isArray(q.options) || !q.options.length) throw new Error('each question needs id, prompt, options[]');
    for (const o of q.options) if (!o.key || !o.label) throw new Error('each option needs key, label');
  }
  const token = crypto.randomBytes(9).toString('base64url'); // 12-char url id
  db.prepare(`INSERT INTO mock_sessions (token, title, spec, created_by) VALUES (@token,@title,@spec,@created_by)`)
    .run({ token, title, spec: JSON.stringify(specObj), created_by });
  return getMockSession(token);
}

export function getMockSession(token) {
  const r = db.prepare('SELECT * FROM mock_sessions WHERE token=?').get(token);
  if (!r) return undefined;
  return { ...r, spec: JSON.parse(r.spec), results: JSON.parse(r.results || '{}') };
}

// Record (or update) the pick for ONE question. Validates the choice is a real option key.
// Flips the session to 'resolved' once every question has a choice.
// CONCURRENCY: this is a read-modify-write of the whole results JSON, safe ONLY because it is
// fully synchronous (better-sqlite3, no await between SELECT and UPDATE). Do NOT add an await
// inside this function or two concurrent picks become a lost-update race.
export function recordMockChoice({ token, questionId, choice, choices, comment = '', me }) {
  if (!me) throw new Error('not authorized');
  const r = db.prepare('SELECT * FROM mock_sessions WHERE token=?').get(token);
  if (!r) throw new Error('no such session');
  const spec = JSON.parse(r.spec);
  const q = (spec.questions || []).find((x) => x.id === questionId);
  if (!q) throw new Error('no such question');
  const results = JSON.parse(r.results || '{}');
  const base = { comment: String(comment).slice(0, 2000), by: me, at: new Date().toISOString() };
  if (q.multi) {
    // multi-select: store the set of liked option keys (validated against real options)
    const arr = (Array.isArray(choices) ? choices : []).filter((k) => q.options.some((o) => o.key === k));
    results[questionId] = { ...base, choices: arr };
  } else {
    if (choice && !q.options.some((o) => o.key === choice)) throw new Error('invalid choice');
    results[questionId] = { ...base, choice: choice || null };
  }
  const allAnswered = (spec.questions || []).every((x) => {
    const e = results[x.id];
    return e && (x.multi ? (e.choices && e.choices.length) : e.choice);
  });
  db.prepare(`UPDATE mock_sessions SET results=@results, status=@status, resolved_at=@resolved WHERE token=@token`)
    .run({ results: JSON.stringify(results), status: allAnswered ? 'resolved' : 'open', resolved: allAnswered ? new Date().toISOString() : r.resolved_at, token });
  return getMockSession(token);
}

// --- scoped share-links (artifact_shares) ----------------------------------
// Threat model: a public, SSO-EXEMPT route (/s/[token]) must serve EXACTLY one artifact to an
// unauthenticated visitor and nothing else. The whole security of that bypass rests here, so:
//   * The token is 32 bytes of crypto-random → base64url (the secret, returned ONCE on creation).
//   * We persist ONLY sha256(token). Lookups hash the incoming token and match on the UNIQUE,
//     indexed token_hash column — an indexed equality lookup on a fixed-length hex digest of a
//     high-entropy secret (no early-exit on the application-supplied value; SQLite compares the
//     stored 64-char hex, not the attacker's raw token). A DB read-out yields hashes, not links.
//   * Validity is enforced IN SQL (revoked=0 AND not expired) so the public route can't forget a check.
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Create a share for `slug`. Returns { token (RAW — show once), id, slug, expires_at }.
// expires_at: pass an ISO/SQL UTC timestamp string or null. The CALLER (the page action) is
// responsible for the canWrite/auth gate — this is a pure data op (mirrors createTask etc.).
export function createArtifactShare({ slug, label = '', created_by = '', expires_at = null }) {
  if (!slug) throw new Error('share requires slug');
  // Don't mint a link for a slug that doesn't exist (defense-in-depth; the action also gates).
  const exists = db.prepare('SELECT 1 FROM artifacts WHERE slug=?').get(slug);
  if (!exists) throw new Error('no such artifact');
  const token = crypto.randomBytes(32).toString('base64url'); // 256-bit secret
  const token_hash = sha256hex(token);
  const r = db.prepare(
    `INSERT INTO artifact_shares (slug, token_hash, label, created_by, expires_at)
       VALUES (@slug, @token_hash, @label, @created_by, @expires_at)`
  ).run({ slug, token_hash, label: label || '', created_by: created_by || '', expires_at: expires_at || null });
  return { id: Number(r.lastInsertRowid), slug, token, expires_at: expires_at || null };
}

// Resolve a RAW token to its artifact — the public-route lookup. FAIL CLOSED: returns the
// artifact row ONLY when a matching share exists, is NOT revoked, and is NOT expired; otherwise
// undefined (the route then 404s uniformly — never distinguishing unknown vs revoked vs expired).
// Ignores artifact visibility ON PURPOSE: a share is an explicit, revocable grant for THAT one
// artifact (so a private artifact can be shared), and it can reach no other slug — the token row
// names a single slug. Defensive: a non-string/empty token short-circuits to undefined.
export function getArtifactByShareToken(token) {
  if (!token || typeof token !== 'string') return undefined;
  const token_hash = sha256hex(token);
  const share = db.prepare(
    `SELECT slug FROM artifact_shares
      WHERE token_hash=@token_hash AND revoked=0
        AND (expires_at IS NULL OR expires_at > datetime('now'))`
  ).get({ token_hash });
  if (!share) return undefined;
  // getArtifact with me=null bypasses the human visibility gate — intentional: the share IS the grant.
  return getArtifact(share.slug, null);
}

// List a single artifact's shares for the management UI (no token/hash leaves the server).
export const listArtifactShares = (slug) => db.prepare(
  `SELECT id, label, created_by, created_at, expires_at, revoked,
          (revoked=0 AND (expires_at IS NULL OR expires_at > datetime('now'))) AS active
     FROM artifact_shares WHERE slug=@slug ORDER BY created_at DESC`
).all({ slug });

// Revoke one share BY ID, scoped to its slug (so a request can't revoke another artifact's share
// by id alone — the page action passes the slug it's authorized for). Idempotent.
export const revokeArtifactShare = (id, slug) => db.prepare(
  'UPDATE artifact_shares SET revoked=1 WHERE id=@id AND slug=@slug'
).run({ id: Number(id), slug }).changes > 0;

// An agent's own queue (for the SessionStart hook + the cockpit) — now LANE-AWARE. Returns the
// tasks this agent is responsible for OR may opportunistically pick up, in two buckets:
//   * assigned: open work whose assignee IS this agent (todo/doing/blocked), regardless of capability
//     (a mayor push-assignment via assignTaskToAgent already passed the gate, so it stays visible).
//   * claimable: UNASSIGNED Up Next tasks this agent MAY claim under the lane gate (capability empty,
//     or a tag the agent holds) — exactly the pool claimNextForAgent would draw from.
// Both buckets are also returned flattened as `tasks` (de-duped) for the simple legacy single-list
// consumer. An unknown/inactive agent gets empty buckets (it owns nothing and may claim nothing).
export function agentQueue(handle) {
  const h = normHandle(handle);
  const agent = getAgent(h);
  const assigned = db.prepare(
    `SELECT * FROM tasks WHERE lower(assignee)=@h AND status IN ('todo','doing','blocked')
       AND ${TASKISH} ${NOTARCHIVED} ORDER BY status, priority, rank`
  ).all({ h });
  // claimable only if the agent exists and is active (inactive owns its assigned but claims nothing).
  let claimable = [];
  if (agent && agent.active) {
    const caps = capSet(agent.capabilities);
    const args = { };
    const capParams = []; let i = 0;
    for (const c of caps) { const k = 'c' + i++; args[k] = c; capParams.push('@' + k); }
    const capPred = capParams.length
      ? `AND (capability='' OR capability IS NULL OR lower(trim(capability)) IN (${capParams.join(',')}))`
      : `AND (capability='' OR capability IS NULL)`;
    claimable = db.prepare(
      `SELECT * FROM tasks
        WHERE up_next=1 AND status='todo' AND kind IN ('task','idea')
          AND (assignee='' OR assignee IS NULL)
          AND (lease_expires_at IS NULL OR lease_expires_at < datetime('now'))
          ${capPred}
          ${NOTARCHIVED}
        ORDER BY rank, priority`
    ).all(args);
  }
  const seen = new Set(assigned.map((t) => t.id));
  const tasks = [...assigned, ...claimable.filter((t) => !seen.has(t.id))];
  return { assigned, claimable, tasks };
}

// Tasks awaiting the lead's verification.
export const needsReview = () => db.prepare(`SELECT * FROM tasks WHERE status='review' ${NOTARCHIVED} ORDER BY updated_at DESC`).all();

// --- /board: the fleet at a glance (fleet-dispatcher Phase 2, #242) -----------
// One aggregate so the board does a single load with no N+1. Everything respects
// the HUMAN visibility gate (vis(me)) exactly like the main board — agents never
// open /board, but the gate is cheap and keeps a private task off the wall if a
// human is viewing. The SERVER pre-computes lease_age_s / lease_state here from the
// raw column (handy, avoids client clock skew); lease_expires_at itself is NOT a
// secret and ships too (only claim_token is stripped).

// In-progress / claimed work, one row per active lease. lane = claimed_by, falling
// back to assignee (an assigned-but-pre-claim 'doing' row still belongs to someone),
// then '(unassigned)'. lease_age_s = now - lease_expires_at in seconds: POSITIVE means
// the lease already expired (reap candidate). lease_state: 'expired' (past), 'soon'
// (<5 min left → amber), else 'ok'. No lease set → null age, 'none' state.
const SOON_S = 300; // 5 min: amber "lease nearly up" window
export function boardLanes(me) {
  const rows = db.prepare(
    `SELECT id, title, status, priority, project_id, assignee, claimed_by, lease_expires_at, updated_at, kind
       FROM tasks
      WHERE status='doing' AND ${TASKISH} ${vis(me)} ${NOTARCHIVED}
      ORDER BY priority, updated_at DESC`
  ).all(me ? { me } : {});
  const nowMs = Date.now();
  const toMs = (ts) => ts ? new Date(ts.replace(' ', 'T') + 'Z').getTime() : null;
  const lanes = new Map();
  for (const r of rows) {
    const exp = toMs(r.lease_expires_at);
    const lease_age_s = exp == null ? null : Math.round((nowMs - exp) / 1000); // >0 = expired
    const lease_state = exp == null ? 'none'
      : lease_age_s >= 0 ? 'expired'
      : -lease_age_s <= SOON_S ? 'soon' : 'ok';
    const who = (r.claimed_by || r.assignee || '').toLowerCase() || '(unassigned)';
    const task = {
      id: r.id, title: r.title, status: r.status, priority: r.priority,
      project_id: r.project_id, kind: r.kind,
      assignee: r.assignee, claimed_by: r.claimed_by,  // claimed_by ships to the UI (drives the swimlanes); not a secret
      lease_age_s, lease_state
    };
    if (!lanes.has(who)) lanes.set(who, { agent: who, tasks: [], expired: 0, soon: 0 });
    const lane = lanes.get(who);
    lane.tasks.push(task);
    if (lease_state === 'expired') lane.expired++;
    else if (lease_state === 'soon') lane.soon++;
  }
  // most-loaded agent first, with any expired-lease lane bubbled to the top (it wants attention)
  return [...lanes.values()].sort((a, b) =>
    (b.expired - a.expired) || (b.tasks.length - a.tasks.length) || a.agent.localeCompare(b.agent));
}

// Stale/reaped log: 'doing' rows whose lease is already in the past (live reap
// candidates — Agent-a's reapLeases() will free these), plus the recent 'closed'
// event ledger (the "why" — reason + by). Two distinct sources, returned separately.
export function staleLog(me, { closedLimit = 15 } = {}) {
  const staleLeases = db.prepare(
    `SELECT id, title, assignee, claimed_by, lease_expires_at, project_id, priority
       FROM tasks
      WHERE status='doing' AND lease_expires_at IS NOT NULL
        AND lease_expires_at < datetime('now') AND ${TASKISH} ${vis(me)} ${NOTARCHIVED}
      ORDER BY lease_expires_at ASC`
  ).all(me ? { me } : {});
  const nowMs = Date.now();
  const toMs = (ts) => ts ? new Date(ts.replace(' ', 'T') + 'Z').getTime() : null;
  const stale = staleLeases.map((r) => ({
    id: r.id, title: r.title, project_id: r.project_id, priority: r.priority,
    assignee: r.assignee, claimed_by: r.claimed_by,
    lease_age_s: r.lease_expires_at ? Math.round((nowMs - toMs(r.lease_expires_at)) / 1000) : null
  }));
  // recent closes from the why-ledger. FAIL CLOSED: INNER JOIN the task + gate visibility IN SQL,
  // so a close whose task was DELETED (no row) or is owner-private to someone else never appears —
  // and the LIMIT applies to already-visible rows (no over-fetch/underfill). (codex+adversarial review)
  const closed = db.prepare(
    `SELECT e.task_id AS id, e.data AS data, e.at AS at,
            t.title AS title, t.status AS status, t.project_id AS project_id
       FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.type='closed' ${me ? "AND (t.visibility='shared' OR t.owner=@me)" : ''}
      ORDER BY e.id DESC LIMIT @lim`
  ).all({ lim: closedLimit, ...(me ? { me } : {}) })
    .map((e) => {
      let reason = '', by = '';
      try { const d = JSON.parse(e.data || '{}'); reason = d.reason || ''; by = d.by || ''; } catch {}
      return { id: e.id, title: e.title ?? `#${e.id}`, status: e.status, project_id: e.project_id, at: e.at, reason, by };
    });
  return { stale, closed };
}

// Per-agent + global running counts. closedToday = 'closed' events since local-ish
// midnight UTC (the DB stores UTC); cheap COUNT off the indexed events table.
export function boardCounts(me) {
  // per-status tallies in one pass over the visible task set
  const byAgent = new Map();
  const get = (a) => { const k = a || '(unassigned)'; if (!byAgent.has(k)) byAgent.set(k, { agent: k, ready: 0, doing: 0, blocked: 0, review: 0, closedToday: 0 }); return byAgent.get(k); };
  const global = { ready: 0, doing: 0, blocked: 0, review: 0, closedToday: 0 };
  // ready = unblocked actionable (todo/up-next), doing, blocked, review — grouped by claimed_by||assignee
  const rows = db.prepare(
    `SELECT status, up_next, blocked_on, claimed_by, assignee
       FROM tasks WHERE ${TASKISH} AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED}`
  ).all(me ? { me } : {});
  for (const r of rows) {
    const who = (r.claimed_by || r.assignee || '').toLowerCase();
    const a = get(who);
    if (r.status === 'doing')       { a.doing++; global.doing++; }
    else if (r.status === 'blocked'){ a.blocked++; global.blocked++; }
    else if (r.status === 'review') { a.review++; global.review++; }
    else if ((r.status === 'todo') && (!r.blocked_on)) { a.ready++; global.ready++; }
  }
  // closed today (from the events ledger; attribute to the {by} actor when present).
  // INNER JOIN + vis() so the count never includes closures of tasks this viewer can't see. (review)
  const closes = db.prepare(
    `SELECT e.data AS data FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.type='closed' AND date(e.at,'localtime') = date('now','localtime')
        ${me ? "AND (t.visibility='shared' OR t.owner=@me)" : ''}`
  ).all(me ? { me } : {});
  for (const c of closes) {
    global.closedToday++;
    let by = ''; try { by = (JSON.parse(c.data || '{}').by || '').toLowerCase(); } catch {}
    get(by).closedToday++;
  }
  return { global, byAgent: Object.fromEntries(byAgent) };
}

// Visibility-aware READY queue for the board. The agent ready() deliberately skips
// the human vis() gate (agents see all); the board is a HUMAN view, so it must not
// surface a private task. Same eligibility predicate as ready(): actionable + unblocked,
// up-next first then manual rank. Capped — the board shows the head of the queue.
export const boardReady = (me, limit = 25) => db.prepare(
  `SELECT id, title, status, priority, up_next, project_id, assignee, kind
     FROM tasks
    WHERE status='todo' AND (blocked_on='' OR blocked_on IS NULL)
      AND ${TASKISH} ${vis(me)} ${NOTARCHIVED}
    ORDER BY up_next DESC, rank, priority LIMIT @lim`
).all({ lim: limit, ...(me ? { me } : {}) });

// The whole board in one call. Reuses needsReview() and the new aggregates.
// `me` is the signed-in human (visibility gate); pass null for an agent (sees all).
//   { lanes:[{agent,tasks:[{id,title,priority,project_id,lease_age_s,lease_state,...}],expired,soon}],
//     counts:{ global:{ready,doing,blocked,review,closedToday}, byAgent:{[agent]:{...}} },
//     review:[task], ready:[task], stale:{ stale:[task], closed:[{id,title,reason,by,at}] },
//     generatedAt }
// lease_age_s / lease_state are SERVER-derived (handy + clock-skew-proof); lease_expires_at also ships now.
export function boardData(me) {
  // needs-human / escalation lane: status='review' (the human-gated items an agent can't
  // self-close). Visibility-gated for the human board (needsReview() itself is the agent path).
  const review = db.prepare(
    `SELECT id, title, status, priority, project_id, assignee, kind, updated_at
       FROM tasks WHERE status='review' AND ${TASKISH} ${vis(me)} ${NOTARCHIVED} ORDER BY updated_at DESC`
  ).all(me ? { me } : {});
  return {
    lanes: boardLanes(me),
    counts: boardCounts(me),
    review,
    ready: boardReady(me),              // visible unblocked queue, ordered (up_next, rank, priority)
    stale: staleLog(me),
    generatedAt: new Date().toISOString()
  };
}

// --- /  (owner cockpit landing) -----------------------------------------------
// One aggregate for the cockpit: the few things that actually want the owner's
// attention, plus the glance-layer graph inputs. Everything is visibility-gated
// by `me` (the signed-in human) exactly like the board — never leak a private
// task/project. Pure reads; additive. Shape:
//   { onFire:[task], needsYou:[{...task, reason:'assigned'|'question'}], inFlight:[task],
//     changedToday:[{id,title,by,at,reason}],
//     graphs:{ momentum:{ closedToday, series:[{day,n}] },
//              backlog:{ total, byPriority:{0,1,2,3} },
//              focus:{ needsYou, onFire, inFlight, total } },
//     hud:{ needsYou, onFire, working }, generatedAt }
// `working` (HUD agent count) is supplied by the caller from getFleet (the live
// per-agent telemetry source) — db.js has no view of the fleet/*.json files.
export function cockpitData(me, { workingAgents = 0 } = {}) {
  const meArgs = me ? { me } : {};

  // ON FIRE — open P0s (priority=0, not done/dropped). Top-level focus; cap so the
  // lane stays a glance, not a list. Visibility-gated.
  const onFire = db.prepare(
    `SELECT id, title, priority, status, project_id, assignee, kind, updated_at
       FROM tasks
      WHERE priority=0 AND ${TASKISH} AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED}
      ORDER BY (status='doing') DESC, updated_at DESC LIMIT 12`
  ).all(meArgs);

  // NEEDS YOU — two sources, de-duped:
  //   * tasks where assignee = ME (open, not already in the on-fire P0 set)
  //   * open questions/decisions (kind='question', unanswered) — agents blocked on a call
  const assigned = me ? db.prepare(
    `SELECT id, title, priority, status, project_id, assignee, kind, updated_at
       FROM tasks
      WHERE lower(assignee)=lower(@me) AND ${TASKISH} AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED}
      ORDER BY priority, updated_at DESC LIMIT 12`
  ).all({ me }) : [];
  const questions = db.prepare(
    `SELECT id, title, priority, status, project_id, assignee, kind, options, updated_at
       FROM tasks
      WHERE kind='question' AND (answer='' OR answer IS NULL) AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED}
      ORDER BY priority, created_at LIMIT 12`
  ).all(meArgs);
  const seen = new Set();
  const needsYou = [];
  for (const q of questions) { if (seen.has(q.id)) continue; seen.add(q.id); needsYou.push({ ...q, reason: 'question' }); }
  for (const t of assigned) { if (seen.has(t.id)) continue; seen.add(t.id); needsYou.push({ ...t, reason: 'assigned' }); }

  // IN FLIGHT — what's moving now (status='doing'). The layout joins live fleet
  // telemetry to these via assignee; here we just hand over the doing rows.
  const inFlight = db.prepare(
    `SELECT id, title, priority, status, project_id, assignee, claimed_by, kind, updated_at
       FROM tasks
      WHERE status='doing' AND ${TASKISH} ${vis(me)} ${NOTARCHIVED}
      ORDER BY updated_at DESC LIMIT 12`
  ).all(meArgs);

  // WHAT CHANGED TODAY — closes from the why-ledger since local-ish midnight (UTC).
  // INNER JOIN + vis() so a close of a task this viewer can't see never appears.
  const changedToday = db.prepare(
    `SELECT e.task_id AS id, e.data AS data, e.at AS at, t.title AS title
       FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.type='closed' AND e.at >= datetime('now','start of day')
        ${me ? "AND (t.visibility='shared' OR t.owner=@me)" : ''}
      ORDER BY e.id DESC LIMIT 20`
  ).all(meArgs).map((e) => {
    let by = '', reason = '';
    try { const d = JSON.parse(e.data || '{}'); by = d.by || ''; reason = d.reason || ''; } catch {}
    return { id: e.id, title: e.title ?? `#${e.id}`, at: e.at, by, reason };
  });

  // GRAPHS — momentum (closes/day incl today), backlog (open by priority), focus donut.
  // momentum: 14-day window of 'closed' events, bucketed by LOCAL (America/Chicago, set via
  // the container TZ) day — UTC bucketing rolled evening-Central closes into the next day, so
  // "closed today" read 0 after ~7pm local (the "I did 4 things but it said nothing" bug). Visibility-gated.
  const closeRows = db.prepare(
    `SELECT date(e.at,'localtime') AS day, COUNT(*) AS n
       FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.type='closed' AND date(e.at,'localtime') >= date('now','localtime','-13 days')
        ${me ? "AND (t.visibility='shared' OR t.owner=@me)" : ''}
      GROUP BY date(e.at,'localtime')`
  ).all(meArgs);
  const byDay = new Map(closeRows.map((r) => [r.day, r.n]));
  // Build the 14 day-keys in the SAME local zone so they match the SQL local-date buckets.
  const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = localDay(Date.now() - i * 86400000);
    series.push({ day: d, n: byDay.get(d) ?? 0 });
  }
  const closedToday = series[series.length - 1].n;

  // backlog: open (active) task counts by priority bucket
  const blRows = db.prepare(
    `SELECT priority, COUNT(*) AS n
       FROM tasks WHERE ${TASKISH} AND ${ACTIVE} ${vis(me)} ${NOTARCHIVED}
      GROUP BY priority`
  ).all(meArgs);
  const byPriority = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let backlogTotal = 0;
  for (const r of blRows) { const p = Number(r.priority); if (p in byPriority) byPriority[p] += r.n; else byPriority[3] += r.n; backlogTotal += r.n; }

  const focus = { needsYou: needsYou.length, onFire: onFire.length, inFlight: inFlight.length };
  focus.total = focus.needsYou + focus.onFire + focus.inFlight;

  return {
    onFire, needsYou, inFlight, changedToday,
    graphs: {
      momentum: { closedToday, series },
      backlog: { total: backlogTotal, byPriority },
      focus
    },
    hud: { needsYou: needsYou.length, onFire: onFire.length, working: workingAgents },
    generatedAt: new Date().toISOString()
  };
}

// --- fleet-terminal audit log (#547). Rows are WRITTEN by server.js's ws proxy (term_audit on
// connect/disconnect; term_audit_input = rw keystroke capture). The schema is mirrored here so the
// admin-only /fleet/audit read never trips over a missing table before any session has opened. ---
db.exec(`
  CREATE TABLE IF NOT EXISTS term_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, mode TEXT,
    connect_ts INTEGER, disconnect_ts INTEGER, client_ip TEXT, user_agent TEXT);
  CREATE TABLE IF NOT EXISTS term_audit_input (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, ts INTEGER, data TEXT);
  CREATE INDEX IF NOT EXISTS idx_term_audit_input_session ON term_audit_input(session_id);`);

const _termSessions = db.prepare(`
  SELECT a.id, a.user, a.mode, a.connect_ts, a.disconnect_ts, a.client_ip, a.user_agent,
         COALESCE(SUM(LENGTH(i.data)), 0) AS input_chars
  FROM term_audit a LEFT JOIN term_audit_input i ON i.session_id = a.id
  GROUP BY a.id ORDER BY a.connect_ts DESC LIMIT ?`);
const _termInput = db.prepare('SELECT data FROM term_audit_input WHERE session_id=? ORDER BY ts, id');
const _termOne = db.prepare('SELECT * FROM term_audit WHERE id=?');

// ADMIN-ONLY (gated in the route): session list, or the full keystroke transcript for one rw
// session. The transcript is deliberately sensitive — accountability for a root-equivalent shell.
export function getTermAudit({ sessionId = null, limit = 200 } = {}) {
  if (sessionId != null) {
    const session = _termOne.get(sessionId);
    if (!session) return { session: null, input: '' };
    return { session, input: _termInput.all(sessionId).map((r) => r.data).join('') };
  }
  return { sessions: _termSessions.all(limit) };
}

export default db;
