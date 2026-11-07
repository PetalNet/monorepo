#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Behaviour tests for scripts/tasks-keeper.mjs, run as the cron runs it (a child process)
// against a TEMP DB seeded through the real db.js helpers.
import Database from "better-sqlite3";

const TMP = mkdtempSync(path.join(tmpdir(), "keeper-test-"));
const DB_PATH = path.join(TMP, "tasks.db");
const OUTBOX = path.join(TMP, "outbox");
const KEEPER = path.resolve(import.meta.filename, "../tasks-keeper.mjs");

process.env.TASKS_DB_PATH = DB_PATH;
delete process.env.TASKS_CONFIG;

const { default: db, ensureProject, createTask } = await import("../src/lib/server/db.js");

const project = ensureProject("keeper-test");
const task = (title, fields, daysOld) => {
	const id = createTask({ project_id: project, title, ...fields });

	db.prepare(`UPDATE tasks SET updated_at=datetime('now', ?) WHERE id=?`).run(
		`-${daysOld} days`,
		id,
	);

	return id;
};

const agingP1 = task("rotting p1", { priority: 1 }, 30);
const blocked = task("blocked with no edge", { status: "blocked" }, 1);
const review = task("forgotten review", { status: "review" }, 10);
const dupA = task("Same Title", {}, 1);
const dupB = task("same title", {}, 1);
const mismatch = task("pending: wire the thing", { body: "this is live now" }, 1);
const fresh = task("fresh p1", { priority: 1 }, 0);
const before = db.prepare("SELECT id, status, updated_at FROM tasks ORDER BY id").all();

db.close();

const run = (args, env = {}) =>
	spawnSync(process.execPath, [KEEPER, ...args], {
		encoding: "utf8",
		env: { ...process.env, TASKS_DB_PATH: DB_PATH, ...env },
	});

const checks = [];

function t(name, fn) {
	try {
		fn();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

const alerted = run(["--alert"], {
	TASKS_KEEPER_OUTBOX: OUTBOX,
	TASKS_KEEPER_NAME: "Ada",
});

t("--alert run exits 0", () => assert.equal(alerted.status, 0, alerted.stderr));

t("--alert drops one digest named for the sender", () => {
	const files = readdirSync(OUTBOX);

	assert.equal(files.length, 1, files.join(", "));
	assert.match(files[0], /^\d+-ada\.json$/);

	const msg = JSON.parse(readFileSync(path.join(OUTBOX, files[0]), "utf8"));

	assert.equal(msg.sender, "ada");
	assert.equal(typeof msg.ts, "number");
	assert.match(msg.body, /^🧹 Ada \(board keeper\) — daily digest\n/);
	assert.match(msg.body, new RegExp(`1 P1s aging >21d \\(oldest #${agingP1} `));
	assert.match(msg.body, new RegExp(`review pileup >7d: #${review}$`, "m"));
	assert.match(msg.body, new RegExp(`blocked w/o blocker edge: #${blocked}$`, "m"));
	assert.match(msg.body, new RegExp(`label/content mismatch: #${mismatch}$`, "m"));
});

t("the markdown report is printed and saved next to the DB", () => {
	const dir = path.join(TMP, "keeper-reports");
	const [file] = readdirSync(dir);
	const saved = readFileSync(path.join(dir, file), "utf8");

	assert.match(file, /^report-\d{4}-\d{2}-\d{2}\.md$/);
	assert.ok(alerted.stdout.startsWith(saved), "stdout does not lead with the saved report");
	assert.match(saved, new RegExp(`- #${agingP1} \\[P1/todo\\] 30(\\.0)?d — rotting p1`));
	assert.match(saved, new RegExp(`- "same title" → #${dupA},${dupB}`));
});

t("--json prints the report and saves nothing new", () => {
	const r = run(["--json"]);

	assert.equal(r.status, 0, r.stderr);

	const report = JSON.parse(r.stdout);

	assert.deepEqual(
		report.health.aging_high_priority.map((x) => x.id),
		[agingP1, fresh],
	);
	assert.deepEqual(
		report.health.blocked_without_edge.map((x) => x.id),
		[blocked],
	);
	assert.equal(readdirSync(OUTBOX).length, 1);
});

t("--alert without an outbox refuses to run", () => {
	const r = run(["--alert"], { TASKS_KEEPER_OUTBOX: "" });

	assert.equal(r.status, 2);
	assert.match(r.stderr, /TASKS_KEEPER_OUTBOX/);
});

t("the keeper never changes a task", () => {
	const ro = new Database(DB_PATH, { readonly: true });
	const after = ro.prepare("SELECT id, status, updated_at FROM tasks ORDER BY id").all();

	ro.close();
	assert.deepEqual(after, before);
});

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
