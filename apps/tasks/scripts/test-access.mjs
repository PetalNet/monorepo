#!/usr/bin/env node
// Behaviour tests for per-owner access on project archives and for the agent claim queue,
// against a TEMP DB. Drives the REAL /projects load and unarchive action and the REAL
// claimNext helper used by the MCP server and the agent RPC.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "access-test-"));

process.env.TASKS_DB_PATH = path.join(TMP, "tasks.db");
delete process.env.TASKS_CONFIG;

const DB = await import("../src/lib/server/db.js");
const { default: db, ensureProject, createTask, archiveProject, claimNext } = DB;
const projects = await import("../src/routes/projects/+page.server.js");

const checks = [];

async function t(name, fn) {
	try {
		await fn();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

function project(name, owner, visibility) {
	const id = ensureProject(name);

	db.prepare("UPDATE projects SET owner=?, visibility=? WHERE id=?").run(owner, visibility, id);

	return id;
}

const isArchived = (name) =>
	db.prepare("SELECT archived_at FROM projects WHERE name=?").get(name).archived_at !== null;

function unarchive(name, user) {
	const body = new FormData();

	body.set("name", name);

	return projects.actions.unarchive({
		request: new Request("http://tasks.test/projects?/unarchive", { method: "POST", body }),
		locals: { user },
	});
}

project("alice-private", "alice", "private");
project("team-shared", "alice", "shared");
archiveProject("alice-private");
archiveProject("team-shared");

await t("another user does not see a private archived project", () => {
	const names = projects.load({ locals: { user: "bob" } }).archived.map((p) => p.name);

	assert.ok(!names.includes("alice-private"), `bob saw ${names.join(", ")}`);
	assert.ok(names.includes("team-shared"));
});

await t("the owner sees her private archived project", () => {
	const names = projects.load({ locals: { user: "alice" } }).archived.map((p) => p.name);

	assert.ok(names.includes("alice-private"));
});

await t("another user cannot restore a private archived project", async () => {
	await unarchive("alice-private", "bob");
	assert.equal(isArchived("alice-private"), true);
});

await t("the owner can restore her private archived project", async () => {
	await unarchive("alice-private", "alice");
	assert.equal(isArchived("alice-private"), false);
});

// Claim queue: an archived project's queued work must never be handed to an agent.
const queued = (projectId, title, rank) => {
	return createTask({
		title,
		kind: "task",
		project_id: projectId,
		up_next: 1,
		status: "todo",
		rank,
	});
};

const archivedId = project("old-work", "alice", "shared");
const activeId = project("live-work", "alice", "shared");
const archivedTask = queued(archivedId, "archived first in line", 1);
const activeTask = queued(activeId, "active second in line", 2);

archiveProject("old-work");

await t("claimNext skips an archived project's task ahead in the queue", () => {
	const claimed = claimNext("agent-a");

	assert.equal(claimed?.id, activeTask, `claimed ${claimed?.id} (${claimed?.title})`);
});

await t("claimNext returns nothing when only archived work is queued", () => {
	assert.equal(claimNext("agent-a"), null);
	assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(archivedTask).status, "todo");
});

db.close();
rmSync(TMP, { recursive: true, force: true });

let failed = 0;

for (const c of checks) {
	console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);

	if (!c.pass) {
		failed++;
	}
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
