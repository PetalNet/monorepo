#!/usr/bin/env node
// One-time migration: drop the tracker tables (tasks, comments, task_blockers, task_links, their
// full-text indexes and triggers, and with `tasks` the task-claim columns) from the live database.
//
// It refuses to run unless an archive of the tracker data exists and matches the database it is
// about to change:
//   - the archive tarball must match its .sha256 file,
//   - it must contain a SQLite copy that passes integrity_check, and
//   - that copy's row counts for the four tables must equal the live counts, so a write after the
//     archive was taken (a cron job, an agent) stops the drop instead of being lost.
// Run it in the deployed image with the archive mounted read-only and the DB writable:
//   docker run --rm --network none --user 1000:1000 -v /home/docker/tasks/data:/data \
//     -v <archive dir>:/archive:ro -e TASKS_DB_PATH=/data/tasks.db tasks:<sha> \
//     node scripts/drop-tracker.mjs /archive/<name>.tar.gz [--yes]
// Without --yes it only checks and prints what it would drop.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const TABLES = ["tasks", "comments", "task_blockers", "task_links"];
const DROP_ORDER = [
	"tasks_fts",
	"comments_fts",
	"task_links",
	"task_blockers",
	"comments",
	"tasks",
];

const [archive, flag] = process.argv.slice(2);

if (!archive) {
	console.error("usage: drop-tracker.mjs <archive.tar.gz> [--yes]");
	process.exit(2);
}

const refuse = (why) => {
	console.error(`refusing: ${why}`);
	process.exit(1);
};

const expected = readFileSync(`${archive}.sha256`, "utf8").split(/\s+/)[0];
const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");

if (expected !== actual) {
	refuse(`archive checksum ${actual} does not match ${expected}`);
}

const work = mkdtempSync(path.join(tmpdir(), "drop-tracker-"));

try {
	execFileSync("tar", ["-xzf", archive, "-C", work, "tasks.db"]);

	const copy = new Database(path.join(work, "tasks.db"), { readonly: true });
	const live = new Database(process.env.TASKS_DB_PATH, { fileMustExist: true });

	if (copy.pragma("integrity_check", { simple: true }) !== "ok") {
		refuse("the archived copy fails integrity_check");
	}

	const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

	for (const table of TABLES) {
		const [archived, current] = [count(copy, table), count(live, table)];

		console.log(`${table}: archive ${archived}, live ${current}`);

		if (archived !== current) {
			refuse(`${table} changed since the archive was taken; archive again`);
		}
	}

	if (flag === "--yes") {
		live.exec(`BEGIN; ${DROP_ORDER.map((t) => `DROP TABLE IF EXISTS ${t};`).join(" ")} COMMIT;`);
		console.log(`dropped: ${DROP_ORDER.join(", ")}`);
	} else {
		console.log("checks pass; rerun with --yes to drop");
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
