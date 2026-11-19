#!/usr/bin/env node
// Tests for the agent-API (bearer-token RPC, POST /api/agent/rpc) against a TEMP DB.
//
// No vitest in this project → a dependency-free node assertion script (same pattern as
// test-public-share.mjs). It drives the REAL handler (src/lib/server/agent-api.js
// handleAgentRpc — the route is a thin transport wrapper) and the REAL db.js helpers on a
// throwaway SQLite file. Never touches the live DB.
//
// Coverage: token round-trip; revoked token rejected; unknown op → 400; missing/garbage
// bearer → 401; rate limit; token never appears in logs; read-only scope; scoped tokens get a
// generic 404 on gallery ops; get_markup.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// temp DB MUST be set before db.js is imported (it opens the file at import time)
const TMP = mkdtempSync(path.join(tmpdir(), "agent-api-test-"));

process.env.TASKS_DB_PATH = path.join(TMP, "tasks.db");

const DB = await import("../src/lib/server/db.js");
const db = DB.default;
const { mintAgentToken, verifyAgentToken, revokeAgentToken } = DB;
const { handleAgentRpc, resetRateLimiter, BODY_MAX } =
	await import("../src/lib/server/agent-api.js");

// ── harness ──────────────────────────────────────────────────────────────────
const checks = [];

function t(name, fn) {
	try {
		fn();
		checks.push({ name, pass: true });
	} catch (e) {
		checks.push({ name, pass: false, detail: e.message });
	}
}

// capture the handler's audit lines (and later prove no token ever leaked into them)
const logLines = [];
const rpc = (token, op, args = {}) => {
	const orig = console.log;

	console.log = (...a) => logLines.push(a.join(" "));

	try {
		return handleAgentRpc({
			authorization: token == null ? undefined : `Bearer ${token}`,
			rawBody: JSON.stringify({ op, args }),
		});
	} finally {
		console.log = orig;
	}
};

const agentA = mintAgentToken({
	agent_name: "agent-a",
	scope_assignee: "agent-a",
	scope_projects: "agentlab",
	readonly: false,
});
const full = mintAgentToken({ agent_name: "agent-b-test", readonly: false }); // unscoped
const projOnly = mintAgentToken({
	agent_name: "agent-a-proj",
	scope_projects: ["agentlab"],
	readonly: false,
});
const asgOnly = mintAgentToken({
	agent_name: "agent-a-asg",
	scope_assignee: "agent-a",
	readonly: false,
});

resetRateLimiter();

t("mint returns plaintext once; verify resolves identity + parsed scopes", () => {
	const v = verifyAgentToken(agentA.token);

	// scope_readonly added with the read-only axis; asserted here so the identity SHAPE
	// stays pinned rather than loosened to a subset match.
	assert.deepEqual(v, {
		agent_name: "agent-a",
		scope_assignee: "agent-a",
		scope_projects: ["agentlab"],
		scope_readonly: false,
	});

	const row = db.prepare("SELECT * FROM agent_tokens WHERE id=?").get(agentA.id);

	assert.ok(row.last_used_at, "last_used_at stamped on verify");
	assert.notEqual(row.token_sha256, agentA.token, "plaintext is not what is stored");
	assert.equal(row.token_sha256.length, 64, "stored value is a sha256 hex digest");
});

t("verify fails closed on garbage / empty / non-string", () => {
	assert.equal(verifyAgentToken("definitely-not-a-token"), null);
	assert.equal(verifyAgentToken(""), null);
	assert.equal(verifyAgentToken(null), null);
});

t("revoked token (by id) no longer verifies and RPC rejects it with 401", () => {
	const tmp = mintAgentToken({ agent_name: "tmp", readonly: false });

	assert.ok(verifyAgentToken(tmp.token));
	assert.equal(revokeAgentToken(tmp.id), 1);
	assert.equal(verifyAgentToken(tmp.token), null);
	assert.equal(rpc(tmp.token, "get_home").status, 401);
});

t("revoke by agent_name kills all of that agent's live tokens", () => {
	const a = mintAgentToken({ agent_name: "multi", readonly: false });
	const b = mintAgentToken({ agent_name: "multi", readonly: false });

	assert.equal(revokeAgentToken("multi"), 2);
	assert.equal(verifyAgentToken(a.token), null);
	assert.equal(verifyAgentToken(b.token), null);
});

t("mint refuses an accidentally-unscoped token (supplied-but-empty scope)", () => {
	// readonly is passed explicitly on every one of these: without it they would throw on
	// the MISSING FLAG rather than the empty scope, stay green, and stop testing scope.
	assert.throws(
		() => mintAgentToken({ agent_name: "x", scope_projects: "", readonly: false }),
		/scope_projects/,
	);

	assert.throws(
		() => mintAgentToken({ agent_name: "x", scope_projects: " , ", readonly: false }),
		/scope_projects/,
	);

	assert.throws(
		() => mintAgentToken({ agent_name: "x", scope_assignee: "  ", readonly: false }),
		/scope_assignee/,
	);

	assert.throws(() => mintAgentToken({ agent_name: "", readonly: false }), /agent_name/);
});

// ── 2. auth gate: missing/garbage bearer → 401, generic body ────────────────
t("missing Authorization header → 401 {error:unauthorized}", () => {
	const r = rpc(null, "get_home");

	assert.equal(r.status, 401);
	assert.deepEqual(r.body, { error: "unauthorized" });
});

t("garbage bearer → 401; non-Bearer scheme → 401 (identical generic bodies)", () => {
	const g = rpc("not-a-real-token", "get_home");

	assert.equal(g.status, 401);
	const b = handleAgentRpc({ authorization: "Basic dXNlcjpwdw==", rawBody: '{"op":"get_home"}' });

	assert.equal(b.status, 401);
	assert.deepEqual(g.body, b.body);
});

// ── 3. protocol: unknown op / bad json / oversized body ──────────────────────
t("unknown op → 400", () => {
	const r = rpc(agentA.token, "drop_all_tables");

	assert.equal(r.status, 400);
	assert.deepEqual(r.body, { error: "unknown_op" });
	assert.equal(rpc(agentA.token, undefined).status, 400); // missing op
});

t("malformed JSON body → 400", () => {
	const r = handleAgentRpc({ authorization: `Bearer ${agentA.token}`, rawBody: "{nope" });

	assert.equal(r.status, 400);
	assert.deepEqual(r.body, { error: "bad_json" });
});

t("oversized body → 413", () => {
	const r = handleAgentRpc({
		authorization: `Bearer ${agentA.token}`,
		rawBody: JSON.stringify({ op: "set_home", args: { markdown: "x".repeat(BODY_MAX + 1) } }),
	});

	assert.equal(r.status, 413);
});

// ── 10. rate limit ────────────────────────────────────────────────────────────
t("rate limit: 61st request inside a minute → 429", () => {
	const ratey = mintAgentToken({ agent_name: "ratey", scope_assignee: "ratey", readonly: false });

	resetRateLimiter();
	let last;

	for (let i = 0; i < 61; i++) {
		last = rpc(ratey.token, "get_home");
	}

	assert.equal(last.status, 429);
	assert.deepEqual(last.body, { error: "rate_limited" });
	resetRateLimiter();
});

// ── 11. hygiene: audit lines exist, tokens never logged ──────────────────────
t("audit log lines are written and NEVER contain a plaintext token", () => {
	assert.ok(
		logLines.some((l) => l.startsWith("[agent-api] agent-a ")),
		"audit lines present",
	);

	const all = logLines.join("\n");

	for (const tok of [agentA, full, projOnly, asgOnly]) {
		assert.ok(!all.includes(tok.token), "plaintext token absent from logs");
	}
});

t("unknown op is NOT echoed into logs — an op set to the token value never leaks it", () => {
	const before = logLines.length;
	const res = rpc(agentA.token, agentA.token); // op === the bearer token string

	assert.equal(res.status, 400);
	const added = logLines.slice(before).join("\n");

	assert.ok(
		!added.includes(agentA.token),
		"the caller-controlled op value (a token) is not written to logs",
	);

	assert.ok(added.includes("unknown-op len="), "unknown op is logged as a length, not its content");
});

t("mintAgentToken REFUSES to mint without an explicit readonly decision", () => {
	assert.throws(() => mintAgentToken({ agent_name: "forgot-the-flag" }), /readonly/);
	assert.throws(() => mintAgentToken({ agent_name: "wrong-type", readonly: "yes" }), /readonly/);
	// positive control: it is the MISSING decision that is refused, not minting itself
	assert.ok(mintAgentToken({ agent_name: "said-so-rw", readonly: false }).token);
	assert.ok(mintAgentToken({ agent_name: "said-so-ro", readonly: true }).token);
});

// ── read-only scope ───────────────────────────────────────────────────────────

// ── read-only scope ───────────────────────────────────────────────────────────
const ro = mintAgentToken({ agent_name: "briefing-ro", readonly: true });
const rw = mintAgentToken({ agent_name: "briefing-rw", readonly: false });

t("read-only token is surfaced by verifyAgentToken", () => {
	assert.equal(verifyAgentToken(ro.token).scope_readonly, true);
	assert.equal(verifyAgentToken(rw.token).scope_readonly, false, "default must stay read-WRITE");
});

t("read-only token CAN call get_home and get_markup", () => {
	assert.equal(rpc(ro.token, "get_home").status, 200);
	assert.equal(rpc(ro.token, "get_markup", { slug: "nope" }).status, 404);
});

t("read-only token is REFUSED set_home with 403, and the page is unchanged", () => {
	const r = rpc(ro.token, "set_home", { markdown: "nope" });

	assert.equal(r.status, 403);
	assert.equal(r.body.error, "read_only_token");
	assert.equal(rpc(rw.token, "get_home").body.markdown, "");
	// positive control: a read-write token is not refused
	assert.equal(rpc(rw.token, "set_home", { markdown: "hi" }).status, 200);
});

t("a scoped token gets a generic 404 on set_home and get_home", () => {
	assert.equal(rpc(agentA.token, "set_home", { markdown: "x" }).status, 404);
	assert.equal(rpc(projOnly.token, "get_home").status, 404);
});

t("the read-only refusal is logged without the token", () => {
	const before = logLines.length;

	rpc(ro.token, "set_home", { markdown: "x" });
	const added = logLines.slice(before).join("\n");

	assert.ok(added.includes("read_only_token"), "refusal is audited");
	assert.ok(!added.includes(ro.token), "token never appears in a log line");
});

// ── get_markup (pencil ink on gallery artifacts) ──────────────────────────────
db.prepare(
	"INSERT INTO artifacts (slug, title, kind, content, owner, visibility) VALUES ('ink-page', 'Ink page', 'interactive', '<p>x</p>', 'person-a', 'private')",
).run();

const stroke = {
	tool: "pen",
	color: "#e5484d",
	width: 4,
	vw: 1024,
	pts: [10, 20, 0.5, 30, 40, 0.7],
};

DB.saveMarkup("ink-page", "person-a", [stroke]);
const roFull = mintAgentToken({ agent_name: "agent-ro-full", readonly: true });

resetRateLimiter();

t("get_markup returns each author's strokes and updated_at to an unscoped token", () => {
	const r = rpc(full.token, "get_markup", { slug: "ink-page" });

	assert.equal(r.status, 200);
	assert.equal(r.body.markups.length, 1);
	assert.equal(r.body.markups[0].author, "person-a");
	assert.deepEqual(r.body.markups[0].strokes, [stroke]);
	assert.ok(r.body.markups[0].updated_at, "updated_at present");
	assert.equal(r.body.content, undefined, "page content only on request");
});

t("get_markup returns the page content when asked", () => {
	assert.equal(
		rpc(full.token, "get_markup", { slug: "ink-page", content: true }).body.content,
		"<p>x</p>",
	);
});

t("get_markup is a read op: an unscoped read-only token may call it", () => {
	assert.equal(rpc(roFull.token, "get_markup", { slug: "ink-page" }).status, 200);
});

t("get_markup author filter narrows to that author", () => {
	assert.equal(
		rpc(full.token, "get_markup", { slug: "ink-page", author: "person-b" }).body.markups.length,
		0,
	);
});

t("get_markup is a generic 404 for a scoped token and for an unknown slug", () => {
	assert.equal(rpc(agentA.token, "get_markup", { slug: "ink-page" }).status, 404);
	assert.equal(rpc(projOnly.token, "get_markup", { slug: "ink-page" }).status, 404);
	assert.equal(rpc(full.token, "get_markup", { slug: "no-such-page" }).status, 404);
});

t("saving an empty stroke list deletes the markup row", () => {
	DB.saveMarkup("ink-page", "person-a", []);
	assert.equal(rpc(full.token, "get_markup", { slug: "ink-page" }).body.markups.length, 0);
});

// ── report ────────────────────────────────────────────────────────────────────
let failed = 0;

for (const c of checks) {
	console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);

	if (!c.pass) {
		failed++;
	}
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

try {
	db.close();
	rmSync(TMP, { recursive: true, force: true });
} catch {}

if (failed) {
	process.exit(1);
}
