#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

// Behaviour tests for scripts/tasks-keeper.mjs, run as the cron runs it (a child process)
// against a TEMP DB seeded through the real db.js helpers.

const TMP = mkdtempSync(path.join(tmpdir(), "keeper-test-"));
const DB_PATH = path.join(TMP, "tasks.db");
const OUTBOX = path.join(TMP, "outbox");
const REPORTS = path.join(TMP, "keeper-reports");
const KEEPER = path.resolve(import.meta.filename, "../tasks-keeper.mjs");

process.env.TASKS_DB_PATH = DB_PATH;
delete process.env.TASKS_CONFIG;

const {
	default: db,
	ensureProject,
	createTask,
	addBlocker,
	archiveProject,
} = await import("../src/lib/server/db.js");

const project = ensureProject("keeper-test");
const task = (title, fields, daysOld) => {
	const id = createTask({ project_id: project, title, ...fields });

	db.prepare(`UPDATE tasks SET updated_at=datetime('now', ?) WHERE id=?`).run(
		`-${daysOld} days`,
		id,
	);

	return id;
};

const agingP0 = task("rotting p0", { priority: 0 }, 40);
const agingP1 = task("rotting p1", { priority: 1 }, 30);
const freshP1 = task("fresh p1", { priority: 1 }, 0);
const blocked = task("blocked with no edge", { status: "blocked" }, 1);
const review = task("forgotten review", { status: "review" }, 10);
const doing = task("stuck doing", { status: "doing" }, 5);

task("fresh doing", { status: "doing" }, 1);

const blocker = task("the blocker", {}, 1);
const blockedWithEdge = task("blocked by the blocker", {}, 1);

addBlocker(blockedWithEdge, blocker);
db.prepare(`UPDATE tasks SET status='blocked' WHERE id=?`).run(blockedWithEdge);

task("old idea", { kind: "idea" }, 9);

const dupA = task("Same Title", {}, 1);
const dupB = task("same title", {}, 1);
const mismatch = task("pending: wire the thing", { body: "this is live now" }, 1);

task("long done", { status: "done" }, 90);

// Just inside each threshold, or closed, so none of these may surface.
task("recent review", { status: "review" }, 6);
task("recent idea", { kind: "idea" }, 6);
task("recently done", { status: "done" }, 59);
task("same title", { status: "done" }, 1);
task("todo: finished", { status: "done", body: "done" }, 1);

// An archived project holding one of every alertable task. None of it may surface.
const archived = ensureProject("keeper-archived");

for (const [title, fields, daysOld] of [
	["archived p1", { priority: 1 }, 50],
	["archived doing", { status: "doing" }, 9],
	["archived review", { status: "review" }, 20],
	["archived idea", { kind: "idea" }, 20],
	["archived blocked", { status: "blocked" }, 1],
	["same title", {}, 1],
	["todo: archived but done", { body: "shipped" }, 1],
	["archived done", { status: "done" }, 90],
]) {
	const id = createTask({ project_id: archived, title, ...fields });

	db.prepare(`UPDATE tasks SET updated_at=datetime('now', ?) WHERE id=?`).run(
		`-${daysOld} days`,
		id,
	);
}

archiveProject("keeper-archived");
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

const fingerprint = () => {
	const ro = new Database(DB_PATH, { readonly: true });
	const rows = ["tasks", "events", "task_blockers", "projects"].map((table) =>
		ro.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
	);

	ro.close();

	return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
};

const before = fingerprint();

const cleanEnv = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith("TASKS_KEEPER_")),
);
const run = (args, env = {}) =>
	spawnSync(process.execPath, [KEEPER, ...args], {
		encoding: "utf8",
		env: { ...cleanEnv, TASKS_DB_PATH: DB_PATH, ...env },
	});
const reports = () => readdirSync(REPORTS);

const checks = [];

function t(name, fn) {
	try {
		fn();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

const startedAt = Date.now();
const alerted = run(["--alert"], { TASKS_KEEPER_OUTBOX: OUTBOX, TASKS_KEEPER_NAME: "Ada" });
const endedAt = Date.now();

t("--alert run exits 0", () => assert.equal(alerted.status, 0, alerted.stderr));

t("--alert drops exactly the expected digest", () => {
	const files = readdirSync(OUTBOX);

	assert.equal(files.length, 1, files.join(", "));
	assert.match(files[0], /^\d{13}000-ada\.json$/);

	const msg = JSON.parse(readFileSync(path.join(OUTBOX, files[0]), "utf8"));

	assert.equal(msg.sender, "ada");
	assert.ok(msg.ts >= startedAt && msg.ts <= endedAt, `ts ${msg.ts} is not epoch ms of this run`);
	assert.equal(files[0], `${msg.ts}000-ada.json`);

	assert.equal(
		msg.body,
		[
			"🧹 Ada (board keeper) — daily digest",
			"Board: 7 todo · 2 doing · 2 review · 2 inbox",
			`⚠ 2 P1s aging >21d (oldest #${agingP0} 40d: rotting p0)`,
			`review pileup >7d: #${review}`,
			"1 inbox untriaged >7d",
			`blocked w/o blocker edge: #${blocked}`,
			`label/content mismatch: #${mismatch}`,
		].join("\n"),
	);
});

t("the markdown report is printed and saved next to the DB", () => {
	const [file] = reports();
	const saved = readFileSync(path.join(REPORTS, file), "utf8");

	assert.match(file, /^report-\d{4}-\d{2}-\d{2}\.md$/);
	assert.ok(alerted.stdout.startsWith(saved), "stdout does not lead with the saved report");

	for (const line of [
		`- #${agingP0} [P0/todo] 40d — rotting p0`,
		`- #${agingP1} [P1/todo] 30d — rotting p1`,
		`- #${freshP1} [P1/todo] 0d — fresh p1`,
		`- #${doing} 5d — stuck doing`,
		`- #${review} 10d — forgotten review`,
		"### Untriaged inbox (>7d): **1**",
		`- #${blocked} — blocked with no edge`,
		`- "same title" → #${dupA},${dupB}`,
		`- #${mismatch} [todo] — pending: wire the thing`,
		"### Terminal tasks >60d old (archive candidates): **1**",
	]) {
		assert.ok(saved.split("\n").includes(line), `missing line: ${line}`);
	}
});

t("--json prints the report and saves nothing", () => {
	rmSync(REPORTS, { recursive: true });
	mkdirSync(REPORTS);

	const r = run(["--json"]);

	assert.equal(r.status, 0, r.stderr);

	const report = JSON.parse(r.stdout);

	assert.deepEqual(
		report.health.aging_high_priority.map((x) => x.id),
		[agingP0, agingP1, freshP1],
	);

	assert.deepEqual(
		report.health.stale_doing.map((x) => x.id),
		[doing],
	);

	assert.equal(report.health.inbox_untriaged.n, 1);
	assert.deepEqual(reports(), []);
	assert.equal(readdirSync(OUTBOX).length, 1);
});

t("TASKS_KEEPER_SENDER overrides the sender", () => {
	const outbox = path.join(TMP, "outbox-sender");
	const r = run(["--alert"], {
		TASKS_KEEPER_OUTBOX: outbox,
		TASKS_KEEPER_NAME: "Ada",
		TASKS_KEEPER_SENDER: "board-bot",
	});
	const [file] = readdirSync(outbox);

	assert.equal(r.status, 0, r.stderr);
	assert.match(file, /^\d{13}000-board-bot\.json$/);
	assert.equal(JSON.parse(readFileSync(path.join(outbox, file), "utf8")).sender, "board-bot");
});

t("--alert without an outbox refuses to run", () => {
	const r = run(["--alert"], { TASKS_KEEPER_OUTBOX: "" });

	assert.equal(r.status, 2);
	assert.match(r.stderr, /TASKS_KEEPER_OUTBOX/);
});

const notADir = path.join(TMP, "not-a-dir");

writeFileSync(notADir, "");

t("an undeliverable digest fails the run but still saves the report", () => {
	const r = run(["--alert"], { TASKS_KEEPER_OUTBOX: notADir });

	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /enqueue failed/);
	assert.equal(reports().length, 1);
});

t("an undeliverable digest also fails a --json run", () => {
	const r = run(["--json", "--alert"], { TASKS_KEEPER_OUTBOX: notADir });

	assert.equal(r.status, 1, r.stderr);
	assert.ok(JSON.parse(r.stdout).db.tasks > 0);
});

t("an unsavable report fails the run but still delivers the digest", () => {
	const outbox = path.join(TMP, "outbox-2");
	const r = run(["--alert"], {
		TASKS_KEEPER_OUTBOX: outbox,
		TASKS_KEEPER_REPORT_DIR: path.join(notADir, "reports"),
	});

	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /report save failed/);
	assert.equal(readdirSync(outbox).length, 1);
});

t("the keeper never changes the board", () => assert.equal(fingerprint(), before));

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
