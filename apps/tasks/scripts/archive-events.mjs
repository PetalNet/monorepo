#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Archive old tracker events to the NAS, then reclaim their space in the live DB. (task-340)
//
// Alice's directive: "just offload to the NAS every so often automatically with a note of
// what is happening." Runs from cron (nightly). LOSSLESS + FAIL-SAFE:
//   • every event is appended to a rolling NDJSON file on the NAS (bucketed by the event's
//     own month) and fsync'd BEFORE the live DB is allowed to prune it;
//   • the live pruner is coupled to a watermark this script advances (db.js), so the DB only
//     ever sheds rows already on the NAS;
//   • if the NAS isn't writable, it archives NOTHING and deletes NOTHING — logs, self-notes,
//     and exits non-zero, so a NAS outage can never lose data.
//
// Flow: ensure NAS writable -> from the watermark, read events in id-order batches -> append
// each to events-YYYY-MM.ndjson + fsync -> advance watermark per batch (crash-resumable) ->
// prune each task's now-archived events to the keep-window -> (auto or --vacuum) VACUUM ->
// log a one-line summary + drop a self-note.
//
// Usage:  node scripts/archive-events.mjs            # nightly: archive + prune (+ vacuum if a lot freed)
//         node scripts/archive-events.mjs --vacuum   # also force a full VACUUM (one-time reclaim)
import {
	mkdirSync,
	openSync,
	writeSync,
	fsyncSync,
	closeSync,
	statSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";

process.env.TASKS_DB_PATH ||= "/srv/tasks/data/tasks.db";
const ARCHIVE_DIR = process.env.EVENTS_ARCHIVE_DIR || "/services/tasks/events-archive";
const SELF_NOTE = process.env.SELF_NOTE_BIN || "/srv/.claude/bin/self-note";
const BATCH = 5000; // id-cursor batch — bounds memory on the big first (~154k) run
const VACUUM_IF_PRUNED = 5000; // auto-VACUUM when a run reclaims at least this many rows
const FORCE_VACUUM = process.argv.includes("--vacuum");
const now = new Date();
const stamp = now.toISOString();

const log = (m) => console.log(`[archive-events ${stamp}] ${m}`);
function note(msg) {
	try {
		execFileSync(SELF_NOTE, [msg], { timeout: 15000 });
	} catch {
		/* never fail the run on a note */
	}
}
function fail(msg) {
	log("ABORT: " + msg);
	note(`Events archive ABORTED (no data touched): ${msg}`);
	process.exit(1);
}
function skip(msg) {
	log(msg);
	process.exit(0);
} // benign no-op exit (e.g. lock held)
// writeSync may short-write; loop until the WHOLE record is on disk before it's ever counted
// as archived (else a truncated NDJSON line could accompany a watermark advance = silent loss).
function writeAll(fd, buf) {
	let off = 0;
	while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

// 0. Single-archiver lock (LOCAL disk, not NFS) — stops overlapping cron runs from appending
//    duplicate records / racing the watermark. A stale lock (>2h, e.g. a timeout-killed run) is
//    reclaimed. Released on exit, only if WE acquired it.
const LOCK = join(dirname(process.env.TASKS_DB_PATH), ".archive-events.lock");
try {
	try {
		if (Date.now() - statSync(LOCK).mtimeMs > 2 * 3600 * 1000) unlinkSync(LOCK);
	} catch {}
	openSync(LOCK, "wx"); // O_EXCL — throws if a live lock already exists
} catch {
	skip(`another archive run holds ${LOCK}; skipping`);
}
process.on("exit", () => {
	try {
		unlinkSync(LOCK);
	} catch {}
});

// 1. NAS must be writable — else abort BEFORE touching the DB (fail-safe).
try {
	mkdirSync(ARCHIVE_DIR, { recursive: true });
	const probe = join(ARCHIVE_DIR, `.write-probe-${process.pid}`);
	writeFileSync(probe, "ok");
	unlinkSync(probe);
} catch (e) {
	fail(`NAS archive dir not writable (${ARCHIVE_DIR}): ${e.message}`);
}

const db = await import("../src/lib/server/db.js");

const startWm = db.getArchiveWatermark();
const maxId = db.maxEventId();
const beforeCount = db.eventCount();
let beforeBytes = 0;
try {
	beforeBytes = statSync(process.env.TASKS_DB_PATH).size;
} catch {}

// 2. Archive everything above the watermark, in id-order batches, advancing the watermark
//    only AFTER each batch is fsync'd to the NAS (so a crash never loses or double-counts).
const monthFds = new Map();
const fdFor = (month) => {
	if (!monthFds.has(month))
		monthFds.set(month, openSync(join(ARCHIVE_DIR, `events-${month}.ndjson`), "a"));
	return monthFds.get(month);
};
let archived = 0,
	bytes = 0,
	cursor = startWm,
	firstId = null,
	lastId = startWm;
while (cursor < maxId) {
	const rows = db.eventsBatchAfter(cursor, BATCH);
	if (rows.length === 0) break;
	const touched = new Set();
	for (const r of rows) {
		const month = (r.at || stamp).slice(0, 7); // YYYY-MM from the event's own timestamp
		const buf = Buffer.from(JSON.stringify(r) + "\n");
		writeAll(fdFor(month), buf); // full-write loop (no short-write truncation)
		bytes += buf.length;
		touched.add(fdFor(month));
		if (firstId === null) firstId = r.id;
		lastId = r.id;
		archived++;
	}
	for (const fd of touched) fsyncSync(fd); // durable on the NAS before we advance
	db.setArchiveWatermark(lastId); // watermark only covers fsync'd rows
	cursor = lastId;
}
for (const fd of monthFds.values()) closeSync(fd);

// 3. Reclaim: prune each task's now-archived events down to the keep-window (pruner is
//    watermark-coupled, so this only deletes rows confirmed on the NAS above).
let pruned = 0;
for (const tid of db.eventTaskIds()) pruned += db.pruneTaskEvents(tid);

// 4. VACUUM to return freed pages to the filesystem — on --vacuum, or when we freed a lot.
let vacuumed = false;
if (FORCE_VACUUM || pruned >= VACUUM_IF_PRUNED) {
	try {
		db.vacuumDb();
		vacuumed = true;
	} catch (e) {
		log(`VACUUM skipped (lock?): ${e.message}`);
	}
}

let afterBytes = 0;
try {
	afterBytes = statSync(process.env.TASKS_DB_PATH).size;
} catch {}
const mb = (b) => (b / 1048576).toFixed(0) + "MB";
const afterCount = db.eventCount();
const summary =
	archived === 0 && pruned === 0
		? `Events archive: nothing new (watermark ${startWm}, ${beforeCount} events live).`
		: `Events archived to NAS: ${archived} events (${mb(bytes)}, ids ${firstId ?? "-"}..${lastId}) -> ${ARCHIVE_DIR}. ` +
			`Pruned ${pruned} now-archived rows from live DB. Events live: ${beforeCount} -> ${afterCount}. ` +
			`DB file: ${mb(beforeBytes)} -> ${mb(afterBytes)}${vacuumed ? " (vacuumed)" : ""}. watermark=${db.getArchiveWatermark()}.`;
log(summary);
note(summary);
