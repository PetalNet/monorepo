#!/usr/bin/env node
// Tests for the agent-API (bearer-token RPC, POST /api/agent/rpc) against a TEMP DB.
//
// No vitest in this project → a dependency-free node assertion script (same pattern as
// guard-public-share.mjs), wired to `pnpm test:agent-api`. It drives the REAL handler
// (src/lib/server/agent-api.js handleAgentRpc — the route is a thin transport wrapper)
// and the REAL db.js helpers, on a throwaway SQLite file. Never touches the live DB.
//
// Coverage (spec §5): token round-trip; revoked token rejected; out-of-scope reads
// filtered; out-of-scope get/update/close → generic 404; claim confined to scope;
// file forced into scope; unknown op → 400; missing/garbage bearer → 401; writes go
// through canonical helpers (blocked-guard + cascade-unblock + events preserved);
// scoped reap; rate limit; token never appears in logs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// temp DB MUST be set before db.js is imported (it opens the file at import time)
const TMP = mkdtempSync(join(tmpdir(), "agent-api-test-"));

process.env.TASKS_DB_PATH = join(TMP, "tasks.db");

const DB = await import("../src/lib/server/db.js");
const db = DB.default;
const {
	mintAgentToken,
	verifyAgentToken,
	revokeAgentToken,
	ensureProject,
	createTask,
	updateTask,
	getTask,
	addBlocker,
} = DB;
const { handleAgentRpc, _resetRateLimiter, BODY_MAX } =
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

// ── fixtures ─────────────────────────────────────────────────────────────────
const secops = ensureProject("secops"); // the sensitive lane agent-a must never see
const agentlab = ensureProject("agentlab"); // agent-a's lane

const mk = (
	title,
	{
		project_id,
		assignee = "",
		status = "todo",
		up_next = 0,
		priority = 2,
		rank = 0,
		kind = "task",
	} = {},
) => {
	const id = createTask({ title, kind, project_id, priority, rank, up_next, status });

	if (assignee || status !== "todo")
		updateTask(id, { ...(assignee ? { assignee } : {}), ...(status !== "todo" ? { status } : {}) });

	return id;
};

// P0 + rank 0 so it would ALWAYS win an unscoped up_next/claim — the honeypot.
const SECRET = mk("P0 secret security finding", {
	project_id: secops,
	assignee: "agent-b",
	up_next: 1,
	priority: 0,
	rank: 0,
});
const MINE = mk("agent-a task one", {
	project_id: agentlab,
	assignee: "agent-a",
	up_next: 1,
	priority: 2,
	rank: 5,
});
const DOING = mk("agent-a in progress", { project_id: agentlab, assignee: "agent-a", status: "doing" });
const Q = mk("agent-a open question", { project_id: agentlab, assignee: "agent-a", kind: "question" });
const SAMEASG_OTHERPROJ = mk("agent-a-assigned but in secops", {
	project_id: secops,
	assignee: "agent-a",
	up_next: 1,
});
const OTHERASG_MYPROJ = mk("agent-b-assigned in agentlab", {
	project_id: agentlab,
	assignee: "agent-b",
	up_next: 1,
});

const agentA = mintAgentToken({
	agent_name: "agent-a",
	scope_assignee: "agent-a",
	scope_projects: "agentlab",
});
const full = mintAgentToken({ agent_name: "agent-b-test" }); // unscoped (sanity)
const projOnly = mintAgentToken({ agent_name: "agent-a-proj", scope_projects: ["agentlab"] });
const asgOnly = mintAgentToken({ agent_name: "agent-a-asg", scope_assignee: "agent-a" });

_resetRateLimiter();

// ── 1. token round-trip / revocation / mint validation ──────────────────────
t("mint returns plaintext once; verify resolves identity + parsed scopes", () => {
	const v = verifyAgentToken(agentA.token);

	assert.deepEqual(v, {
		agent_name: "agent-a",
		scope_assignee: "agent-a",
		scope_projects: ["agentlab"],
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
	const tmp = mintAgentToken({ agent_name: "tmp" });

	assert.ok(verifyAgentToken(tmp.token));
	assert.equal(revokeAgentToken(tmp.id), 1);
	assert.equal(verifyAgentToken(tmp.token), null);
	assert.equal(rpc(tmp.token, "get_ready").status, 401);
});

t("revoke by agent_name kills all of that agent's live tokens", () => {
	const a = mintAgentToken({ agent_name: "multi" });
	const b = mintAgentToken({ agent_name: "multi" });

	assert.equal(revokeAgentToken("multi"), 2);
	assert.equal(verifyAgentToken(a.token), null);
	assert.equal(verifyAgentToken(b.token), null);
});

t("mint refuses an accidentally-unscoped token (supplied-but-empty scope)", () => {
	assert.throws(() => mintAgentToken({ agent_name: "x", scope_projects: "" }));
	assert.throws(() => mintAgentToken({ agent_name: "x", scope_projects: " , " }));
	assert.throws(() => mintAgentToken({ agent_name: "x", scope_assignee: "  " }));
	assert.throws(() => mintAgentToken({ agent_name: "" }));
});

// ── 2. auth gate: missing/garbage bearer → 401, generic body ────────────────
t("missing Authorization header → 401 {error:unauthorized}", () => {
	const r = rpc(null, "get_ready");

	assert.equal(r.status, 401);
	assert.deepEqual(r.body, { error: "unauthorized" });
});

t("garbage bearer → 401; non-Bearer scheme → 401 (identical generic bodies)", () => {
	const g = rpc("not-a-real-token", "get_ready");

	assert.equal(g.status, 401);
	const b = handleAgentRpc({ authorization: "Basic dXNlcjpwdw==", rawBody: '{"op":"get_ready"}' });

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
		rawBody: JSON.stringify({ op: "file", args: { title: "x".repeat(BODY_MAX + 1) } }),
	});

	assert.equal(r.status, 413);
});

// ── 4. scoped reads: out-of-scope rows are filtered, filters can't widen ─────
t("get_ready (scoped): returns ONLY in-scope tasks; the secret never appears", () => {
	const r = rpc(agentA.token, "get_ready");

	assert.equal(r.status, 200);

	const ids = [
		...r.body.up_next.map((x) => x.id),
		...r.body.in_progress.map((x) => x.id),
		...r.body.open_questions.map((x) => x.id),
	];

	assert.ok(ids.includes(MINE), "in-scope up_next present");
	assert.ok(ids.includes(DOING), "in-scope doing present");
	assert.ok(ids.includes(Q), "in-scope question present");
	assert.ok(!ids.includes(SECRET), "secret excluded");
	assert.ok(!ids.includes(SAMEASG_OTHERPROJ), "assignee-match/project-miss excluded");
	assert.ok(!ids.includes(OTHERASG_MYPROJ), "project-match/assignee-miss excluded");

	assert.ok(
		!JSON.stringify(r.body).includes("secret security finding"),
		"secret title absent from payload",
	);
});

t("get_ready (unscoped token): sees the whole tracker (sanity)", () => {
	const r = rpc(full.token, "get_ready");

	assert.ok(r.body.up_next.some((x) => x.id === SECRET));
});

t("args can NARROW but never WIDEN the scope (probes return empty, not errors)", () => {
	for (const probe of [{ assignee: "agent-b" }, { project: "secops" }]) {
		const r = rpc(agentA.token, "get_ready", probe);

		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { up_next: [], in_progress: [], open_questions: [] });
	}
});

t("up_next (scoped): skips the higher-priority out-of-scope task", () => {
	const r = rpc(agentA.token, "up_next");

	assert.equal(r.body.task?.id, MINE, "returns MINE, not the P0 secret");
});

t("each scope axis confines independently (project-only and assignee-only tokens)", () => {
	assert.equal(rpc(projOnly.token, "get", { id: OTHERASG_MYPROJ }).status, 200);
	assert.equal(rpc(projOnly.token, "get", { id: SECRET }).status, 404);
	assert.equal(rpc(asgOnly.token, "get", { id: SAMEASG_OTHERPROJ }).status, 200);
	assert.equal(rpc(asgOnly.token, "get", { id: OTHERASG_MYPROJ }).status, 404);
});

// ── 5. get/update/close by id: out-of-scope is a generic 404 ─────────────────
t("get: out-of-scope id and nonexistent id are INDISTINGUISHABLE 404s", () => {
	const a = rpc(agentA.token, "get", { id: SECRET });
	const b = rpc(agentA.token, "get", { id: 99999999 });

	assert.equal(a.status, 404);
	assert.equal(b.status, 404);
	assert.deepEqual(a.body, b.body);
	assert.deepEqual(a.body, { error: "not_found" });
});

t("get: in-scope id → 200 with the shaped task", () => {
	const r = rpc(agentA.token, "get", { id: MINE });

	assert.equal(r.status, 200);
	assert.equal(r.body.task.project, "agentlab");
	assert.equal(r.body.task.assignee, "agent-a");
	assert.equal(rpc(agentA.token, "get", { id: "MINE" }).status, 400); // non-integer id
});

t("update: out-of-scope → 404 and the row is untouched", () => {
	const before = getTask(SECRET).title;
	const r = rpc(agentA.token, "update", { id: SECRET, title: "pwned" });

	assert.equal(r.status, 404);
	assert.equal(getTask(SECRET).title, before);
});

t("update: in-scope → 200 via canonical updateTask (audit event logged)", () => {
	const r = rpc(agentA.token, "update", {
		id: MINE,
		title: "agent-a task one (renamed)",
		priority: 1,
	});

	assert.equal(r.status, 200);
	assert.equal(getTask(MINE).title, "agent-a task one (renamed)");

	assert.ok(
		db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='update'").get(MINE),
		"canonical 'update' event exists",
	);
});

t("update: cannot move a task out of scope or touch server-only columns", () => {
	assert.equal(rpc(agentA.token, "update", { id: MINE, assignee: "agent-b" }).status, 400);
	assert.equal(rpc(agentA.token, "update", { id: MINE, project: "secops" }).status, 400);
	assert.equal(rpc(agentA.token, "update", { id: MINE, owner: "agent-a" }).status, 400); // not in allowlist
	assert.equal(rpc(agentA.token, "update", { id: MINE, visibility: "shared" }).status, 400); // not in allowlist
	assert.equal(rpc(agentA.token, "update", { id: MINE, claim_token: "x" }).status, 400); // not in allowlist
	assert.equal(rpc(agentA.token, "update", { id: MINE, status: "nonsense" }).status, 400);
	assert.equal(getTask(MINE).assignee, "agent-a");
	assert.equal(getTask(MINE).project_id, agentlab);
});

t("close: out-of-scope → 404; missing reason → 422 rejected (why-ledger enforced)", () => {
	assert.equal(rpc(agentA.token, "close", { id: SECRET, reason: "x" }).status, 404);
	const r = rpc(agentA.token, "close", { id: MINE });

	assert.equal(r.status, 422);
	assert.equal(r.body.rejected.reason, "reason_required");
	assert.notEqual(getTask(MINE).status, "done");
});

t("update: terminal/doing statuses are refused — must route through close/claim", () => {
	const c = mk("status-guard task", { project_id: agentlab, assignee: "agent-a" });

	for (const status of ["done", "dropped", "doing"]) {
		assert.equal(
			rpc(agentA.token, "update", { id: c, status }).status,
			400,
			`update status=${status} rejected`,
		);
	}

	assert.equal(getTask(c).status, "todo", "task status unchanged by the rejected updates");
	assert.equal(rpc(agentA.token, "update", { id: c, status: "review" }).status, 200); // safe transition still works
	assert.equal(getTask(c).status, "review");
});

t("shape: parent_id is withheld when the parent is out of scope, kept when in scope", () => {
	const oosChild = createTask({
		title: "child of secret",
		kind: "task",
		project_id: agentlab,
		parent_id: SECRET,
	});

	updateTask(oosChild, { assignee: "agent-a" });

	const inChild = createTask({
		title: "child of MINE",
		kind: "task",
		project_id: agentlab,
		parent_id: MINE,
	});

	updateTask(inChild, { assignee: "agent-a" });
	const a = rpc(agentA.token, "get", { id: oosChild });

	assert.equal(a.status, 200);

	assert.equal(
		a.body.task.parent_id,
		undefined,
		"out-of-scope parent id is NOT leaked (no existence oracle)",
	);

	const b = rpc(agentA.token, "get", { id: inChild });

	assert.equal(b.body.task.parent_id, MINE, "in-scope parent id is preserved");
});

// ── 6. claim: confined to scope by construction ──────────────────────────────
t("claim: grabs the in-scope task, never the better-ranked P0 secret; worker is pinned", () => {
	const r = rpc(agentA.token, "claim", { worker: "agent-b" }); // forged worker must be ignored

	assert.equal(r.status, 200);
	assert.equal(r.body.claimed?.id, MINE);
	assert.ok(r.body.token, "claim token returned");
	const row = getTask(MINE);

	assert.equal(row.status, "doing");

	assert.equal(
		row.claimed_by,
		"agent-a",
		"claimed_by is the token identity, not the forged worker arg",
	);

	assert.ok(
		db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='claim'").get(MINE),
		"canonical 'claim' event exists",
	);

	assert.equal(getTask(SECRET).status, "todo", "secret untouched");
});

t("claim: with only out-of-scope work available → {claimed:null}", () => {
	// MINE is now doing; the remaining up_next=1 todos (SECRET, SAMEASG_OTHERPROJ,
	// OTHERASG_MYPROJ) are all out of agent-a's scope.
	const r = rpc(agentA.token, "claim", {});

	assert.equal(r.status, 200);
	assert.equal(r.body.claimed, null);
	assert.equal(getTask(SECRET).status, "todo");
	assert.equal(getTask(SAMEASG_OTHERPROJ).status, "todo");
	assert.equal(getTask(OTHERASG_MYPROJ).status, "todo");
});

t("claim: an out-of-scope project arg yields null, not out-of-scope work", () => {
	const r = rpc(agentA.token, "claim", { project: "secops" });

	assert.equal(r.body.claimed, null);
});

// ── 7. writes ride the canonical helpers: invariants hold ────────────────────
t("blocked-guard: rpc update to blocked with no live blocker → 422 rejected", () => {
	const c = mk("no blockers here", { project_id: agentlab, assignee: "agent-a" });
	const r = rpc(agentA.token, "update", { id: c, status: "blocked" });

	assert.equal(r.status, 422);
	assert.equal(r.body.rejected.reason, "no_blockers");
});

t("cascade-unblock + why-ledger: rpc close frees the dependent and logs it", () => {
	const a = mk("blocker task", { project_id: agentlab, assignee: "agent-a" });
	const b = mk("dependent task", { project_id: agentlab, assignee: "agent-a" });

	addBlocker(b, a);
	updateTask(b, { status: "blocked" });
	assert.equal(getTask(b).status, "blocked");

	const r = rpc(agentA.token, "close", {
		id: a,
		reason: "shipped via rpc",
		result_summary: "done cleanly",
	});

	assert.equal(r.status, 200);
	assert.equal(getTask(a).status, "done");
	assert.equal(getTask(a).close_reason, "shipped via rpc");
	assert.equal(getTask(a).result_summary, "done cleanly");
	assert.equal(getTask(b).status, "todo", "dependent auto-unblocked (cascade preserved)");

	assert.ok(
		db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='closed'").get(a),
		"canonical 'closed' event exists",
	);
});

// ── 8. file: the new task is FORCED into scope ────────────────────────────────
t("file: out-of-scope project → 400; project omitted under a project scope → 400", () => {
	assert.equal(rpc(agentA.token, "file", { title: "sneak", project: "secops" }).status, 400);
	assert.equal(rpc(agentA.token, "file", { title: "floating" }).status, 400);
});

t("file: lands in scope with assignee FORCED to the token scope", () => {
	const r = rpc(agentA.token, "file", {
		title: "scouted idea",
		project: "agentlab",
		assignee: "agent-b",
		kind: "idea",
	});

	assert.equal(r.status, 201);
	assert.equal(r.body.filed.project, "agentlab");

	assert.equal(
		r.body.filed.assignee,
		"agent-a",
		"assignee overridden to the scope, not the caller value",
	);

	assert.equal(r.body.filed.status, "inbox");
	const k = rpc(agentA.token, "file", { title: "scouted task", project: "agentlab", kind: "task" });

	assert.equal(k.body.filed.status, "todo");
});

t("file: parent/discovered_from cannot reference out-of-scope tasks (no existence oracle)", () => {
	const oos = rpc(agentA.token, "file", { title: "sub", project: "agentlab", parent_id: SECRET });
	const missing = rpc(agentA.token, "file", {
		title: "sub",
		project: "agentlab",
		parent_id: 99999999,
	});

	assert.equal(oos.status, 400);
	assert.equal(missing.status, 400);

	assert.deepEqual(
		oos.body,
		missing.body,
		"out-of-scope and nonexistent parents are indistinguishable",
	);

	assert.equal(
		rpc(agentA.token, "file", { title: "x", project: "agentlab", discovered_from: SECRET }).status,
		400,
	);
});

t("file: unscoped token without a project falls back to the default project (MCP parity)", () => {
	const r = rpc(full.token, "file", { title: "floating idea from unscoped token" });

	assert.equal(r.status, 201);
	assert.equal(r.body.filed.project, "inbox");
});

// ── 9. reap: only this agent\'s own leases ────────────────────────────────────
t("reap: flips only leases claimed by this agent_name", () => {
	const mkLease = (title, who) => {
		const id = mk(title, { project_id: agentlab, assignee: who });

		updateTask(id, {
			status: "doing",
			claimed_by: who,
			claim_token: "tok-" + who,
			lease_expires_at: "2020-01-01 00:00:00",
		});

		return id;
	};

	const mineExpired = mkLease("agent-a stale lease", "agent-a");
	const theirsExpired = mkLease("agent-b stale lease", "agent-b");
	const r = rpc(agentA.token, "reap", {});

	assert.equal(r.status, 200);
	assert.equal(r.body.reaped, 1);
	assert.equal(getTask(mineExpired).status, "todo");
	assert.equal(getTask(theirsExpired).status, "doing", "someone else's lease untouched");
});

// ── 10. rate limit ────────────────────────────────────────────────────────────
t("rate limit: 61st request inside a minute → 429", () => {
	const ratey = mintAgentToken({ agent_name: "ratey", scope_assignee: "ratey" });

	_resetRateLimiter();
	let last;

	for (let i = 0; i < 61; i++) last = rpc(ratey.token, "up_next");

	assert.equal(last.status, 429);
	assert.deepEqual(last.body, { error: "rate_limited" });
	_resetRateLimiter();
});

// ── 11. hygiene: audit lines exist, tokens never logged ──────────────────────
t("audit log lines are written and NEVER contain a plaintext token", () => {
	assert.ok(
		logLines.some((l) => l.startsWith("[agent-api] agent-a ")),
		"audit lines present",
	);

	const all = logLines.join("\n");

	for (const tok of [agent-a, full, projOnly, asgOnly]) {
		assert.ok(!all.includes(tok.token), "plaintext token absent from logs");
	}
});

t("unknown op is NOT echoed into logs — an op set to the token value never leaks it", () => {
	const before = logLines.length;
	const r = rpc(agentA.token, agentA.token); // op === the bearer token string

	assert.equal(r.status, 400);
	const added = logLines.slice(before).join("\n");

	assert.ok(
		!added.includes(agentA.token),
		"the caller-controlled op value (a token) is not written to logs",
	);

	assert.ok(added.includes("unknown-op len="), "unknown op is logged as a length, not its content");
});

// ── report ────────────────────────────────────────────────────────────────────
let failed = 0;

for (const c of checks) {
	console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);

	if (!c.pass) failed++;
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

try {
	db.close();
	rmSync(TMP, { recursive: true, force: true });
} catch {}

if (failed) process.exit(1);
