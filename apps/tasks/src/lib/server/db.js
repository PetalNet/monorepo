import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { canonicalLink, normalizeLinks } from "../links.js";

// Local SQLite is the source of truth (design: tracker-design-2026-05-26.md).
// The default MUST be absolute, anchored to the repo's data/ dir (this module lives at
// src/lib/server/db.js → repo root is three dirs up, then data/). A bare relative 'tasks.db'
// followed the CWD, so a process started from a different directory silently opened a NEW empty
// DB and wrote there — invisible data loss (task-337). Warn when the env is unset so the
// canonical deploy path (TASKS_DB_PATH) is always explicit.
const DEFAULT_DB_PATH = path.resolve(import.meta.filename, "../../../../data/tasks.db");

if (!process.env.TASKS_DB_PATH) {
	console.warn(`[db] TASKS_DB_PATH unset; defaulting to ${DEFAULT_DB_PATH}`);
}

const DB_PATH = process.env.TASKS_DB_PATH || DEFAULT_DB_PATH;

try {
	mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch {}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000"); // multi-writer safety

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    backend    TEXT NOT NULL DEFAULT 'local_private',   -- local_private | github_public
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
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
  -- artifacts / pages gallery: browsable writeups an agent generates (dossiers, research pages,
  -- future briefs) served INSIDE tasks behind the existing Authentik gate, instead of one-off
  -- gated subdomains (brain.tracker.example.com / tag.tracker.example.com). Content is stored IN the DB (the
  -- source of truth the container already mounts) — no on-disk file path => no path-traversal
  -- surface. kind: 'markdown' renders through renderMd (sanitized, inline .prose); 'html' is a
  -- pre-built standalone document served raw into a locked-down sandbox <iframe> (it cannot run
  -- scripts, reach the parent DOM/cookies, or make same-origin requests — see /gallery/[slug]/raw);
  -- 'interactive' is the same standalone-document delivery but ALLOWED to run its own JS for live
  -- demos — sandboxed allow-scripts WITHOUT allow-same-origin (opaque origin). A confidentiality
  -- cage: its JS cannot read the SSO cookie, reach the parent DOM, navigate the top frame, or make
  -- any scripted background request (default-src 'none'). The one inherent residual — a script can
  -- navigate its OWN frame out, leaking the viewer IP — is mitigated by author-only content (no user
  -- upload path), so it's as trusted as anything else an agent publishes. See /gallery/[slug]/raw.
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
  -- pencil markup drawn over an html/interactive artifact, one row per (artifact, author).
  -- strokes is a JSON array in page coordinates (shape in src/lib/ink.js). No row = no ink.
  CREATE TABLE IF NOT EXISTS artifact_markup (
    slug       TEXT NOT NULL,
    author     TEXT NOT NULL,
    strokes    TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (slug, author)
  );
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
  -- Agent registry (fleet-dispatcher, #212). The authoritative list of which agents exist and
  -- — critically — what each MAY work. Today lane/capability routing is purely ADVISORY (the
  -- suggested_agent / owner_machine / capability HINTS on a task). This table is the ENFORCED
  -- side: agent capability metadata is stored here for server-side routing
  -- (the agent never supplies its own filter), so an out-of-lane agent is blocked by the DB, not
  -- by politely asking the model. lane is a coarse human label (open|work|lab|...); the real
  -- gate is capabilities (a CSV of tags) checked against a task's capability tag.
  -- autonomy (auto|ask|readonly|paused) is advisory today except 'paused'/inactive, which the
  -- claim/assign paths treat as "can work nothing". Idempotent create — see ensureAgentsTable too.
  CREATE TABLE IF NOT EXISTS agents (
    handle       TEXT PRIMARY KEY,                         -- canonical lowercase id (e.g. 'agent-f')
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
	const have = new Set(
		db
			.prepare("PRAGMA table_info(agents)")
			.all()
			.map((c) => c.name),
	);
	const adds = {
		display_name: "TEXT DEFAULT ''",
		host: "TEXT DEFAULT ''",
		role: "TEXT DEFAULT ''",
		lane: "TEXT DEFAULT 'open'",
		capabilities: "TEXT DEFAULT ''",
		autonomy: "TEXT DEFAULT 'ask'",
		active: "INTEGER NOT NULL DEFAULT 1",
		created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
		updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
	};

	for (const [name, def] of Object.entries(adds)) {
		if (!have.has(name)) {
			try {
				db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${def}`);
			} catch (e) {
				if (!/duplicate column/i.test(e.message)) {
					throw e;
				}
			}
		}
	}
}

ensureAgentsTable();

// Projects also carry owner + visibility (the dropdown must not leak private project names).
function ensureProjectColumns() {
	const have = new Set(
		db
			.prepare("PRAGMA table_info(projects)")
			.all()
			.map((c) => c.name),
	);

	if (!have.has("owner")) {
		db.exec("ALTER TABLE projects ADD COLUMN owner TEXT DEFAULT ''");
	}

	if (!have.has("visibility")) {
		db.exec("ALTER TABLE projects ADD COLUMN visibility TEXT DEFAULT 'shared'");
	}

	if (!have.has("archived_at")) {
		db.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
	}
}

ensureProjectColumns();

// A gallery page can belong to one named collection (e.g. 'makkit'); '' means none. Pages are
// published by writing the table directly, so the CHECK is the boundary that refuses a bad
// value: lowercase letters, digits and hyphens, starting alphanumeric, at most 32 characters.
// Nothing in the app rewrites the column, so a plain UPDATE of other fields leaves it alone.
function ensureArtifactColumns() {
	const have = new Set(
		db
			.prepare("PRAGMA table_info(artifacts)")
			.all()
			.map((c) => c.name),
	);

	if (!have.has("collection")) {
		db.exec(`ALTER TABLE artifacts ADD COLUMN collection TEXT NOT NULL DEFAULT ''
      CHECK (collection = '' OR (length(collection) <= 32
        AND collection GLOB '[a-z0-9]*' AND collection NOT GLOB '*[^a-z0-9-]*'))`);
	}
}

ensureArtifactColumns();

// The bridge (janet.* in a published page): every artifact carries a revision, the capabilities
// its page may use ("feedback"), and the audience that may answer on it. Additive columns with
// defaults, so the release before this one still reads and writes the same file.
function ensureBridgeColumns() {
	const columns = (table) =>
		new Set(
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((c) => c.name),
		);
	const adds = {
		artifacts: {
			rev: "INTEGER NOT NULL DEFAULT 1",
			caps: "TEXT NOT NULL DEFAULT '[]'",
			audience: "TEXT NOT NULL DEFAULT '[]'",
			// the GitHub PR/issue/repo/commit refs the page demos or decides (see src/lib/links.js)
			links: "TEXT NOT NULL DEFAULT '[]'",
		},
		// A share link carries its own audience: who a link may answer as is not who the artifact asks.
		artifact_shares: { audience: "TEXT NOT NULL DEFAULT '[]'" },
	};

	for (const [table, add] of Object.entries(adds)) {
		const have = columns(table);

		for (const [name, def] of Object.entries(add)) {
			if (!have.has(name)) {
				db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
			}
		}
	}
}

ensureBridgeColumns();

// One row per answer a viewer gives on a page. Scoped through slug: the artifact decides the
// project (collection), visibility and audience, so a row never crosses to another artifact.
// payload is opaque to the platform (the page defines it); anchor/ink/crop locate it on the page.
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL,
    rev             INTEGER NOT NULL,
    author          TEXT NOT NULL,
    via_share_id    INTEGER,
    anchor          TEXT NOT NULL DEFAULT '{}',
    payload         TEXT NOT NULL DEFAULT 'null',
    ink             TEXT,
    crop            TEXT,
    matrix_event_id TEXT,
    status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','seen','resolved')),
    resolution      TEXT,
    resolved_rev    INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_slug ON feedback(slug, rev);
  CREATE INDEX IF NOT EXISTS idx_feedback_author ON feedback(author, status);
`);

// --- artifacts / pages gallery ---------------------------------------------
// Human visibility gate, identical rule to tasks: a private artifact is owner-only.
// `me` is ALWAYS supplied for web views, so the gate is never skipped there. Callers that
// pass null do their own authorization: a share token, or an unscoped agent token. Listing returns metadata only — never the (large) content blob.
const artVis = (me) => (me ? "WHERE (visibility='shared' OR owner=@me)" : "");

/**
 * @param {string | null | undefined} me
 * @returns {{
 * 	id: number;
 * 	slug: string;
 * 	title: string;
 * 	description: string;
 * 	kind: string;
 * 	source: string;
 * 	owner: string;
 * 	visibility: string;
 * 	collection: string;
 * 	links: string;
 * 	created_at: string;
 * 	updated_at: string;
 * }[]}
 */
export const listArtifacts = (me) =>
	db
		.prepare(
			`SELECT id, slug, title, description, kind, source, owner, visibility, collection, links, created_at, updated_at
   FROM artifacts ${artVis(me)} ORDER BY updated_at DESC`,
		)
		.all(me ? { me } : {});

// Fetch ONE artifact by slug, enforcing the same visibility gate in SQL. Returns
// undefined when the slug is unknown OR the caller may not see it (so callers 404
// uniformly — a private artifact never reveals its existence to an outsider).
export const getArtifact = (slug, me) =>
	db
		.prepare(
			`SELECT * FROM artifacts WHERE slug=@slug ${me ? "AND (visibility='shared' OR owner=@me)" : ""}`,
		)
		.get({ slug, ...(me ? { me } : {}) });

export function getMockSession(token) {
	const r = db.prepare("SELECT * FROM mock_sessions WHERE token=?").get(token);

	if (!r) {
		return undefined;
	}

	return { ...r, spec: JSON.parse(r.spec), results: JSON.parse(r.results || "{}") };
}

// Record (or update) the pick for ONE question. Validates the choice is a real option key.
// Flips the session to 'resolved' once every question has a choice.
// CONCURRENCY: this is a read-modify-write of the whole results JSON, safe ONLY because it is
// fully synchronous (better-sqlite3, no await between SELECT and UPDATE). Do NOT add an await
// inside this function or two concurrent picks become a lost-update race.
export function recordMockChoice({ token, questionId, choice, choices, comment = "", me }) {
	if (!me) {
		throw new Error("not authorized");
	}

	const r = db.prepare("SELECT * FROM mock_sessions WHERE token=?").get(token);

	if (!r) {
		throw new Error("no such session");
	}

	const spec = JSON.parse(r.spec);
	const q = (spec.questions || []).find((x) => x.id === questionId);

	if (!q) {
		throw new Error("no such question");
	}

	const results = JSON.parse(r.results || "{}");
	const base = { comment: String(comment).slice(0, 2000), by: me, at: new Date().toISOString() };

	if (q.multi) {
		// multi-select: store the set of liked option keys (validated against real options)
		const arr = (Array.isArray(choices) ? choices : []).filter((k) =>
			q.options.some((o) => o.key === k),
		);

		results[questionId] = { ...base, choices: arr };
	} else {
		if (choice && !q.options.some((o) => o.key === choice)) {
			throw new Error("invalid choice");
		}

		results[questionId] = { ...base, choice: choice || null };
	}

	const allAnswered = (spec.questions || []).every((x) => {
		const e = results[x.id];

		return e && (x.multi ? e.choices?.length : e.choice);
	});

	db.prepare(
		`UPDATE mock_sessions SET results=@results, status=@status, resolved_at=@resolved WHERE token=@token`,
	).run({
		results: JSON.stringify(results),
		status: allAnswered ? "resolved" : "open",
		resolved: allAnswered ? new Date().toISOString() : r.resolved_at,
		token,
	});

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
const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

// Resolve a RAW token to its artifact — the public-route lookup. FAIL CLOSED: returns the
// artifact row ONLY when a matching share exists, is NOT revoked, and is NOT expired; otherwise
// undefined (the route then 404s uniformly — never distinguishing unknown vs revoked vs expired).
// Ignores artifact visibility ON PURPOSE: a share is an explicit, revocable grant for THAT one
// artifact (so a private artifact can be shared), and it can reach no other slug — the token row
// names a single slug. Defensive: a non-string/empty token short-circuits to undefined.
export function getArtifactByShareToken(token) {
	if (!token || typeof token !== "string") {
		return undefined;
	}

	const token_hash = sha256hex(token);
	const share = db
		.prepare(
			`SELECT slug FROM artifact_shares
      WHERE token_hash=@token_hash AND revoked=0
        AND (expires_at IS NULL OR expires_at > datetime('now'))`,
		)
		.get({ token_hash });

	if (!share) {
		return undefined;
	}

	// getArtifact with me=null bypasses the human visibility gate — intentional: the share IS the grant.
	return getArtifact(share.slug, null);
}

// --- artifact markup (pencil ink) -------------------------------------------
// Callers authorize first (getArtifact with the viewer, or an unscoped agent token).
const markupRow = (r) =>
	r && { author: r.author, strokes: JSON.parse(r.strokes), updated_at: r.updated_at };

export const getMarkup = (slug, author) =>
	markupRow(
		db
			.prepare("SELECT author, strokes, updated_at FROM artifact_markup WHERE slug=? AND author=?")
			.get(slug, author),
	);

export const listMarkup = (slug) =>
	db
		.prepare("SELECT author, strokes, updated_at FROM artifact_markup WHERE slug=? ORDER BY author")
		.all(slug)
		.map(markupRow);

// Saving an empty list deletes the row, so a cleared page leaves nothing behind.
export function saveMarkup(slug, author, strokes) {
	if (strokes.length === 0) {
		db.prepare("DELETE FROM artifact_markup WHERE slug=? AND author=?").run(slug, author);

		return null;
	}

	db.prepare(
		`INSERT INTO artifact_markup (slug, author, strokes) VALUES (?, ?, ?)
     ON CONFLICT(slug, author) DO UPDATE SET strokes=excluded.strokes, updated_at=datetime('now')`,
	).run(slug, author, JSON.stringify(strokes));

	return getMarkup(slug, author);
}

// --- agent bearer tokens (agent-API: POST /api/agent/rpc) -------------------
// Threat model mirrors artifact_shares: an SSO-EXEMPT route authenticated purely by a
// bearer token, over a tracker holding sensitive P0 findings. So:
//   * token = 32 crypto-random bytes → base64url; returned ONCE at mint, NEVER persisted.
//   * only sha256(token) hex is stored (UNIQUE, indexed) — a DB read-out yields hashes,
//     not working credentials.
//   * scope_assignee / scope_projects confine the token to its lane: the RPC endpoint
//     (src/lib/server/agent-api.js) refuses to read or write ANY task outside
//     (assignee AND project-set) scope. NULL scope column = unrestricted on that axis.
//   * revoked_at kills a token permanently; verifyAgentToken is fail-closed
//     (unknown/revoked/empty → null, never a partial identity).
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id             INTEGER PRIMARY KEY,
    agent_name     TEXT NOT NULL,            -- 'agent-a'
    token_sha256   TEXT NOT NULL UNIQUE,     -- hex sha256 of the plaintext token; PLAINTEXT NEVER STORED
    scope_assignee TEXT,                     -- if set: agent may only see/act on tasks with this assignee
    scope_projects TEXT,                     -- if set: CSV of project NAMES the agent may see/act on
    scope_readonly INTEGER NOT NULL DEFAULT 0, -- 1 = may only call READ ops; every write op is refused
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at   TEXT,
    revoked_at     TEXT
  );
`);

// scope_readonly arrived after the table did. Existing tokens stay read-write (0) so no
// deployed agent breaks; read-only is opt-in at mint time.
{
	const have = new Set(
		db
			.prepare("PRAGMA table_info(agent_tokens)")
			.all()
			.map((c) => c.name),
	);

	if (!have.has("scope_readonly")) {
		db.exec("ALTER TABLE agent_tokens ADD COLUMN scope_readonly INTEGER NOT NULL DEFAULT 0");
	}
}

// Mint a token for one agent. scope_projects accepts an array or a CSV string; stored as
// CSV. A scope that was SUPPLIED but normalizes to empty is rejected (a typo'd
// `--projects ""` must not silently mint an UNSCOPED token — fail closed, not open).
export function mintAgentToken({
	agent_name,
	scope_assignee = null,
	scope_projects = null,
	readonly,
} = {}) {
	const name = String(agent_name ?? "").trim();

	if (!name) {
		throw new Error("mintAgentToken requires agent_name");
	}

	// REQUIRED, deliberately undefaulted. A default of false is the forgettable kind: the
	// risk is not the tokens that exist today but the one minted months from now by
	// someone who never read this file. Write authority has to be typed out.
	if (typeof readonly !== "boolean") {
		throw new TypeError(
			"mintAgentToken requires readonly:true|false — say whether this token may write",
		);
	}

	let projectsCsv = null;

	if (scope_projects != null) {
		const list = (
			Array.isArray(scope_projects) ? scope_projects : String(scope_projects).split(",")
		)
			.map((s) => String(s).trim())
			.filter(Boolean);

		if (list.length === 0) {
			throw new Error("scope_projects was supplied but empty — refusing to mint an unscoped token");
		}

		projectsCsv = list.join(",");
	}

	const assignee = scope_assignee == null ? null : String(scope_assignee).trim();

	if (scope_assignee != null && !assignee) {
		throw new Error("scope_assignee was supplied but empty — refusing to mint an unscoped token");
	}

	const token = randomBytes(32).toString("base64url"); // 256-bit secret, shown ONCE
	const r = db
		.prepare(
			`INSERT INTO agent_tokens (agent_name, token_sha256, scope_assignee, scope_projects, scope_readonly)
       VALUES (@agent_name, @token_sha256, @scope_assignee, @scope_projects, @scope_readonly)`,
		)
		.run({
			agent_name: name,
			token_sha256: sha256hex(token),
			scope_assignee: assignee,
			scope_projects: projectsCsv,
			scope_readonly: readonly ? 1 : 0,
		});

	return { id: Number(r.lastInsertRowid), token };
}

// Resolve a RAW bearer token to its identity + scope. FAIL CLOSED: returns null for a
// missing/non-string/unknown/revoked token — never a partial match. On a hit, stamps
// last_used_at (usage audit trail). scope_projects is returned as a parsed array (or null).
export function verifyAgentToken(token) {
	if (!token || typeof token !== "string") {
		return null;
	}

	const row = db
		.prepare("SELECT * FROM agent_tokens WHERE token_sha256=? AND revoked_at IS NULL")
		.get(sha256hex(token));

	if (!row) {
		return null;
	}

	db.prepare("UPDATE agent_tokens SET last_used_at=datetime('now') WHERE id=?").run(row.id);

	return {
		agent_name: row.agent_name,
		scope_assignee: row.scope_assignee || null,
		scope_projects: row.scope_projects
			? row.scope_projects
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: null,
		// Read-write unless the column explicitly says otherwise. This is deliberately
		// BACK-COMPAT rather than fail-closed: the migration backfills every existing row to
		// 0, and flipping absent/NULL to read-only would silently break every token minted
		// before this column existed. Read-only is opt-in at mint time.
		scope_readonly: Boolean(row.scope_readonly),
	};
}

// Revoke by numeric id (one token) or by agent_name (ALL of that agent's live tokens —
// the incident-response path: "kill everything agent-a holds"). Idempotent; returns count.
export function revokeAgentToken(idOrName) {
	const byId = Number.isInteger(idOrName) || /^\d+$/.test(String(idOrName));

	return db
		.prepare(
			`UPDATE agent_tokens SET revoked_at=datetime('now')
      WHERE revoked_at IS NULL AND ${byId ? "id=@v" : "agent_name=@v"}`,
		)
		.run({ v: byId ? Number(idOrName) : String(idOrName) }).changes;
}

// --- publish + feedback (the bridge) ------------------------------------------
const stringList = (name, v) => {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) {
		throw new Error(`${name} must be a list of non-empty strings`);
	}

	return JSON.stringify([...new Set(v)]);
};

// Publish or revise a page. A new slug starts at rev 1; republishing an existing slug bumps rev,
// which is what an open page watches to pick up Janet's revision. Every other field is replaced when
// given and kept when omitted, so a content-only edit never silently re-opens or closes a question.
/**
 * @param {{
 * 	slug: string;
 * 	title: string;
 * 	content: string;
 * 	description?: string;
 * 	kind?: string;
 * 	source?: string;
 * 	owner?: string;
 * 	visibility?: string;
 * 	collection?: string;
 * 	caps?: string[];
 * 	audience?: string[];
 * 	links?: (string | { url: string; kind?: string; label?: string })[];
 * }} page
 * @returns {Record<string, any>}
 */
export function upsertArtifact({
	slug,
	title,
	description,
	kind,
	content,
	source,
	owner,
	visibility,
	collection,
	caps,
	audience,
	links,
}) {
	if (!slug || !title || !content) {
		throw new Error("artifact requires slug, title, content");
	}

	if (kind !== undefined && !["markdown", "html", "interactive"].includes(kind)) {
		throw new Error("artifact kind must be markdown|html|interactive");
	}

	if (visibility !== undefined && visibility !== "shared" && visibility !== "private") {
		throw new Error("artifact visibility must be shared|private");
	}

	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
		throw new Error("artifact slug must be lowercase alphanumeric + dashes");
	}

	// Every optional field is kept when omitted (null -> COALESCE to the stored value), so Janet
	// revising a page's content never silently makes a private page shared or clears its owner.
	// A new slug takes the defaults.
	db.prepare(
		`INSERT INTO artifacts (slug,title,description,kind,content,source,owner,visibility,collection,caps,audience,links)
       VALUES (@slug,@title,COALESCE(@description,''),COALESCE(@kind,'markdown'),@content,COALESCE(@source,''),
               COALESCE(@owner,''),COALESCE(@visibility,'shared'),COALESCE(@collection,''),
               COALESCE(@caps,'[]'),COALESCE(@audience,'[]'),COALESCE(@links,'[]'))
     ON CONFLICT(slug) DO UPDATE SET
       title=@title, content=@content,
       description=COALESCE(@description, description), kind=COALESCE(@kind, kind),
       source=COALESCE(@source, source), owner=COALESCE(@owner, owner),
       visibility=COALESCE(@visibility, visibility), collection=COALESCE(@collection, collection),
       caps=COALESCE(@caps, caps), audience=COALESCE(@audience, audience), links=COALESCE(@links, links),
       rev=rev+1, updated_at=datetime('now')`,
	).run({
		slug,
		title,
		content,
		description: description ?? null,
		kind: kind ?? null,
		source: source ?? null,
		owner: owner ?? null,
		visibility: visibility ?? null,
		collection: collection ?? null,
		caps: caps === undefined ? null : stringList("caps", caps),
		audience: audience === undefined ? null : stringList("audience", audience),
		links: links === undefined ? null : JSON.stringify(normalizeLinks(links)),
	});

	return getArtifact(slug, null);
}

const feedbackRow = (r) =>
	r && {
		...r,
		anchor: JSON.parse(r.anchor),
		payload: JSON.parse(r.payload),
		ink: r.ink == null ? null : JSON.parse(r.ink),
	};

export const getFeedback = (id) =>
	feedbackRow(db.prepare("SELECT * FROM feedback WHERE id=?").get(id));

export const listFeedback = (slug, { status } = {}) =>
	db
		.prepare(
			`SELECT * FROM feedback WHERE slug=@slug ${status ? "AND status=@status" : ""} ORDER BY id`,
		)
		.all({ slug, ...(status ? { status } : {}) })
		.map(feedbackRow);

// The caller has already authorized the author for this slug (see the Feedback service); the rev
// is read here, never taken from the caller, so a row always names the page revision it answers.
export function insertFeedback({ slug, author, via_share_id = null, anchor, payload, ink, crop }) {
	const a = db.prepare("SELECT rev FROM artifacts WHERE slug=?").get(slug);

	if (!a) {
		throw new Error("no such artifact");
	}

	const r = db
		.prepare(
			`INSERT INTO feedback (slug, rev, author, via_share_id, anchor, payload, ink, crop)
       VALUES (@slug, @rev, @author, @via_share_id, @anchor, @payload, @ink, @crop)`,
		)
		.run({
			slug,
			rev: a.rev,
			author,
			via_share_id,
			anchor: JSON.stringify(anchor ?? {}),
			payload: JSON.stringify(payload ?? null),
			ink: ink == null ? null : JSON.stringify(ink),
			crop: crop ?? null,
		});

	return getFeedback(Number(r.lastInsertRowid));
}

export const setFeedbackMatrixEvent = (id, eventId) =>
	db.prepare("UPDATE feedback SET matrix_event_id=? WHERE id=?").run(eventId, id).changes;

// Janet closes an item. resolved_rev defaults to the artifact's current rev, i.e. the revision
// she just published in answer. Resolving twice keeps the first resolution.
/** @param {{ id: number; resolution: string; resolved_rev?: number }} item */
export function resolveFeedback({ id, resolution, resolved_rev }) {
	const f = db.prepare("SELECT slug, status FROM feedback WHERE id=?").get(id);

	if (!f) {
		return undefined;
	}

	if (f.status !== "resolved") {
		db.prepare(
			`UPDATE feedback SET status='resolved', resolution=@resolution,
         resolved_rev=COALESCE(@resolved_rev, (SELECT rev FROM artifacts WHERE slug=feedback.slug))
       WHERE id=@id`,
		).run({ id, resolution: String(resolution ?? ""), resolved_rev: resolved_rev ?? null });
	}

	return getFeedback(id);
}

// What an open page polls: the current revision and the viewer's own items on it. Callers
// authorize the slug first (getArtifact with the viewer).
/**
 * @param {string} slug
 * @param {string} viewer
 * @returns {{ rev: number; updated_at: string; feedback: any[] } | undefined}
 */
export function artifactState(slug, viewer) {
	const a = db.prepare("SELECT rev, updated_at FROM artifacts WHERE slug=?").get(slug);

	return (
		a && {
			rev: a.rev,
			updated_at: a.updated_at,
			feedback: db
				.prepare("SELECT * FROM feedback WHERE slug=? AND author=? ORDER BY id")
				.all(slug, viewer)
				.map(feedbackRow),
		}
	);
}

// Artifacts that ask this viewer something they have not answered at the current revision:
// the viewer is in the audience, the page has the "feedback" capability, and the viewer can see it.
export const needsYou = (viewer) =>
	db
		.prepare(
			`SELECT a.slug, a.title, a.collection, a.rev, a.updated_at FROM artifacts a
       WHERE (a.visibility='shared' OR a.owner=@viewer)
         AND EXISTS (SELECT 1 FROM json_each(a.audience) WHERE value=@viewer)
         AND EXISTS (SELECT 1 FROM json_each(a.caps) WHERE value='feedback')
         AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.slug=a.slug AND f.rev=a.rev AND f.author=@viewer)
       ORDER BY a.updated_at DESC`,
		)
		.all({ viewer });

// Pages with answers nobody has resolved yet, newest answer first. Respects the viewer's
// visibility like every other listing.
/**
 * @param {string} viewer
 * @returns {{ slug: string; title: string; collection: string; count: number; latest: string }[]}
 */
export const openFeedback = (viewer) =>
	db
		.prepare(
			`SELECT a.slug, a.title, a.collection, COUNT(*) AS count, MAX(f.created_at) AS latest
       FROM feedback f JOIN artifacts a ON a.slug=f.slug
       WHERE f.status!='resolved' AND (a.visibility='shared' OR a.owner=@viewer)
       GROUP BY a.slug ORDER BY latest DESC`,
		)
		.all({ viewer });

// The pages that link to a GitHub PR, issue, commit or repo, given any form of the reference
// ("owner/repo#12", a URL). Respects the viewer's visibility like every other listing; me=null
// (host scripts) sees everything.
/**
 * @param {string} ref
 * @param {string | null} me
 * @returns {{
 * 	slug: string;
 * 	title: string;
 * 	collection: string;
 * 	rev: number;
 * 	links: string;
 * 	updated_at: string;
 * }[]}
 */
export function findArtifactsByLink(ref, me) {
	const url = canonicalLink(ref);

	if (!url) {
		return [];
	}

	return db
		.prepare(
			`SELECT slug, title, collection, rev, links, updated_at FROM artifacts a
       WHERE ${me ? "(a.visibility='shared' OR a.owner=@me) AND" : ""}
         EXISTS (SELECT 1 FROM json_each(a.links) WHERE json_extract(value,'$.url')=@url)
       ORDER BY updated_at DESC`,
		)
		.all({ url, ...(me ? { me } : {}) });
}

export default db;
