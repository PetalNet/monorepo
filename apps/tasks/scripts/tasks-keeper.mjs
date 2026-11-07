#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// tasks-keeper: a daily, read-only board health and consolidation report.
//
// It reads the board and flags health and consolidation issues for a human pass. It never
// mutates tasks; closing, merging and retiring stay a human step. Event-table size is
// archive-events.mjs's job, so this never touches events.
//
// Usage:  node scripts/tasks-keeper.mjs            # markdown to stdout, saved under keeper-reports/
//         node scripts/tasks-keeper.mjs --json     # machine-readable report on stdout
//         node scripts/tasks-keeper.mjs --alert    # also drop a digest into TASKS_KEEPER_OUTBOX
//
// --alert writes one JSON file ({ sender, body, ts }) into the outbox directory, renamed into
// place so a watcher never reads a partial file. Delivering it is the watcher's job.
import Database from "better-sqlite3";

const DB_PATH =
	process.env.TASKS_DB_PATH || path.resolve(import.meta.filename, "../../data/tasks.db");
const REPORT_DIR =
	process.env.TASKS_KEEPER_REPORT_DIR || path.join(path.dirname(DB_PATH), "keeper-reports");
const KEEPER_NAME = process.env.TASKS_KEEPER_NAME || "Keeper";
const KEEPER_SENDER = process.env.TASKS_KEEPER_SENDER || KEEPER_NAME.toLowerCase();
const OUTBOX = process.env.TASKS_KEEPER_OUTBOX;
const JSON_OUT = process.argv.includes("--json");
const ALERT = process.argv.includes("--alert");

if (ALERT && !OUTBOX) {
	console.error("[keeper] --alert needs TASKS_KEEPER_OUTBOX");
	process.exit(2);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const all = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);
const AGE = "julianday('now') - julianday(updated_at)";
// Tasks in archived projects are off the board, the same rule the board itself applies.
const ON_BOARD =
	"(project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))";

const report = {
	generated_at: new Date().toISOString(),
	status_counts: all(
		`SELECT status, COUNT(*) n FROM tasks WHERE ${ON_BOARD} GROUP BY status ORDER BY n DESC`,
	),
	health: {
		aging_high_priority: all(
			`SELECT id, priority, status, round(${AGE},1) days, title FROM tasks
       WHERE ${ON_BOARD} AND status NOT IN ('done','dropped') AND priority <= 1
       ORDER BY ${AGE} DESC LIMIT 12`,
		),
		stale_doing: all(
			`SELECT id, round(${AGE},1) days, title FROM tasks
       WHERE ${ON_BOARD} AND status='doing' AND ${AGE} > 3 ORDER BY ${AGE} DESC`,
		),
		review_pileup: all(
			`SELECT id, round(${AGE},1) days, title FROM tasks
       WHERE ${ON_BOARD} AND status='review' AND ${AGE} > 7 ORDER BY ${AGE} DESC LIMIT 15`,
		),
		inbox_untriaged: one(
			`SELECT COUNT(*) n FROM tasks WHERE ${ON_BOARD} AND status='inbox' AND ${AGE} > 7`,
		),
		// A blocked task with no blocker edge can never auto-unblock.
		blocked_without_edge: all(
			`SELECT id, title FROM tasks WHERE ${ON_BOARD} AND status='blocked'
       AND id NOT IN (SELECT task_id FROM task_blockers)`,
		),
	},
	consolidation_candidates: {
		duplicate_titles: all(
			`SELECT lower(title) t, COUNT(*) n, group_concat(id) ids
       FROM tasks WHERE ${ON_BOARD} AND status NOT IN ('done','dropped')
       GROUP BY lower(title) HAVING n > 1`,
		),
		// The title says pending/TODO while the body announces it done.
		label_content_mismatch: all(
			`SELECT id, status, title FROM tasks
       WHERE ${ON_BOARD} AND status NOT IN ('done','dropped')
       AND (lower(title) LIKE '%pending%' OR lower(title) LIKE '%todo%')
       AND (lower(body) LIKE '%done%' OR lower(body) LIKE '%resolved%' OR lower(body) LIKE '%shipped%' OR lower(body) LIKE '%is live%')
       LIMIT 20`,
		),
		terminal_archive_candidates: one(
			`SELECT COUNT(*) n FROM tasks WHERE ${ON_BOARD} AND status IN ('done','dropped') AND ${AGE} > 60`,
		),
	},
	db: {
		tasks: one("SELECT COUNT(*) n FROM tasks").n,
		events: one("SELECT COUNT(*) n FROM events").n,
		artifacts: one("SELECT COUNT(*) n FROM artifacts").n,
		events_note:
			"managed by scripts/archive-events.mjs (nightly NAS archive + keep-window prune); not bloat",
	},
};

db.close();

const ids = (rows) => rows.map((t) => `#${t.id}`).join(", ");

function digest() {
	const h = report.health;
	const c = report.consolidation_candidates;
	const sc = Object.fromEntries(report.status_counts.map((s) => [s.status, s.n]));
	const agingP1 = h.aging_high_priority.filter((t) => t.days > 21);
	const bits = [
		`🧹 ${KEEPER_NAME} (board keeper) — daily digest`,
		`Board: ${sc.todo || 0} todo · ${sc.doing || 0} doing · ${sc.review || 0} review · ${sc.inbox || 0} inbox`,
	];

	if (agingP1.length > 0) {
		bits.push(
			`⚠ ${agingP1.length} P1s aging >21d (oldest #${agingP1[0].id} ${agingP1[0].days}d: ${agingP1[0].title})`,
		);
	}

	if (h.review_pileup.length > 0) {
		bits.push(`review pileup >7d: ${ids(h.review_pileup)}`);
	}

	if (h.inbox_untriaged.n) {
		bits.push(`${h.inbox_untriaged.n} inbox untriaged >7d`);
	}

	if (h.blocked_without_edge.length > 0) {
		bits.push(`blocked w/o blocker edge: ${ids(h.blocked_without_edge)}`);
	}

	if (c.label_content_mismatch.length > 0) {
		bits.push(`label/content mismatch: ${ids(c.label_content_mismatch)}`);
	}

	return bits.join("\n");
}

if (ALERT) {
	try {
		mkdirSync(OUTBOX, { recursive: true });
		const ts = Date.now();
		const f = path.join(OUTBOX, `${ts}000-${KEEPER_SENDER}.json`);

		writeFileSync(`${f}.tmp`, JSON.stringify({ sender: KEEPER_SENDER, body: digest(), ts }));
		renameSync(`${f}.tmp`, f);
		console.error(`[keeper] digest -> ${OUTBOX}`);
	} catch (error) {
		console.error("[keeper] enqueue failed:", error.message);
		process.exitCode = 1;
	}
}

if (JSON_OUT) {
	console.log(JSON.stringify(report, null, 2));
	process.exit();
}

const H = report.health;
const C = report.consolidation_candidates;
const lines = [];
const p = (s = "") => lines.push(s);
const each = (rows, fmt) => {
	if (rows.length > 0) {
		for (const row of rows) {
			p(fmt(row));
		}
	} else {
		p("None. ✓");
	}
};

p(`# tasks-keeper report — ${report.generated_at}`);
p(`\n**Board:** ${report.status_counts.map((s) => `${s.n} ${s.status}`).join(" · ")}`);
p(`\n## Health (act on these)`);
p(`\n### Aging high-priority (P0/P1 still open)`);
each(
	H.aging_high_priority,
	(t) => `- #${t.id} [P${t.priority}/${t.status}] ${t.days}d — ${t.title}`,
);
p(`\n### Stale 'doing' (>3d untouched)`);
each(H.stale_doing, (t) => `- #${t.id} ${t.days}d — ${t.title}`);
p(`\n### Review pileup (>7d in review — done or abandoned?)`);
each(H.review_pileup, (t) => `- #${t.id} ${t.days}d — ${t.title}`);
p(`\n### Untriaged inbox (>7d): **${H.inbox_untriaged.n}**`);
p(`\n### Blocked without a blocker edge (can't auto-unblock)`);
each(H.blocked_without_edge, (t) => `- #${t.id} — ${t.title}`);
p(`\n## Consolidation candidates (REPORT-ONLY — gated, never auto-applied)`);
p(`\n### Duplicate open titles`);
each(C.duplicate_titles, (d) => `- "${d.t}" → #${d.ids}`);
p(`\n### Label/content mismatch (title says pending/todo, body says done)`);
each(C.label_content_mismatch, (t) => `- #${t.id} [${t.status}] — ${t.title}`);
p(`\n### Terminal tasks >60d old (archive candidates): **${C.terminal_archive_candidates.n}**`);
p(
	`\n## DB: ${report.db.tasks} tasks · ${report.db.events} events · ${report.db.artifacts} artifacts`,
);
p(`_events: ${report.db.events_note}_`);
p(
	`\n---\n_Report-only. Acting on consolidation items is a gated/human step — this keeper never mutates the board._`,
);

const out = lines.join("\n");

console.log(out);

try {
	mkdirSync(REPORT_DIR, { recursive: true });
	const f = path.join(REPORT_DIR, `report-${report.generated_at.slice(0, 10)}.md`);

	writeFileSync(f, out);
	console.log(`\n[report saved: ${f}]`);
} catch (error) {
	console.error("[keeper] report save failed:", error.message);
	process.exitCode = 1;
}
