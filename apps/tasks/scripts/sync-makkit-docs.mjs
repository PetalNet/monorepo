#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

// sync-makkit-docs: mirror the gallery pages tagged collection='makkit' into the Makkit staff
// app's Docs reader.
//
// It reads the tasks DB read-only and keeps no state of its own. Each run asks Makkit what it
// holds (docs_index), publishes every tagged shared page whose hash differs or is missing, and
// retires every indexed slug that is no longer a tagged shared page (untagged, made private, or
// deleted). A second run with nothing edited makes no changing call.
//
// Usage:  node scripts/sync-makkit-docs.mjs            # sync
//         node scripts/sync-makkit-docs.mjs --dry-run  # print what would be pushed, send nothing
//
// Env:    MAKKIT_API_URL, MAKKIT_ANON_KEY, MAKKIT_AGENT_KEY_FILE (a path to a file holding a
//         docs_publish agent key), TASKS_DB_PATH.
//
// Only html and interactive pages sync. Markdown pages are rendered by the web app's renderMd,
// whose dependencies the production image does not ship, so they are skipped and reported.

const DB_PATH =
	process.env.TASKS_DB_PATH || path.resolve(import.meta.filename, "../../data/tasks.db");
const DRY_RUN = process.argv.includes("--dry-run");
// The gateway's 426 gate (deploy/dev/gateway/client.conf) accepts any non-empty value.
const CLIENT = "tasks-sync/1";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_HTML = 2_000_000;
const MAX_TITLE = 200;
const TIMEOUT_MS = 30_000;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function readTagged() {
	const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

	try {
		return db
			.prepare(
				`SELECT slug, title, kind, content FROM artifacts
         WHERE collection='makkit' AND visibility='shared' ORDER BY slug`,
			)
			.all();
	} finally {
		db.close();
	}
}

function skipReason(r) {
	if (r.kind === "markdown") {
		return "markdown pages are not synced";
	}

	if (!SLUG_RE.test(r.slug)) {
		return "invalid slug";
	}

	if (!r.title || r.title.length > MAX_TITLE) {
		return `title must be 1 to ${MAX_TITLE} characters`;
	}

	if (r.content.length > MAX_HTML) {
		return `html is over ${MAX_HTML} characters`;
	}

	return null;
}

// Split tagged pages into those we can push and those we skip, with the reason for each skip.
function classify(rows) {
	const pages = [];
	const skipped = [];

	for (const r of rows) {
		const why = skipReason(r);

		if (why) {
			skipped.push({ slug: r.slug, why });
		} else {
			pages.push({
				slug: r.slug,
				title: r.title,
				html: r.content,
				hash: sha256(`${r.title}\n${r.content}`),
			});
		}
	}

	return { pages, skipped };
}

function agentCaller() {
	const base = process.env.MAKKIT_API_URL;
	const anon = process.env.MAKKIT_ANON_KEY;
	const keyFile = process.env.MAKKIT_AGENT_KEY_FILE;

	if (!base || !anon || !keyFile) {
		throw new Error("set MAKKIT_API_URL, MAKKIT_ANON_KEY and MAKKIT_AGENT_KEY_FILE");
	}

	const key = readFileSync(keyFile, "utf8").trim();

	if (!key) {
		throw new Error(`${keyFile} is empty`);
	}

	return async (fn, args) => {
		const res = await fetch(`${base.replace(/\/+$/, "")}/rest/v1/rpc/agent_call`, {
			method: "POST",
			headers: {
				apikey: anon,
				Authorization: `Bearer ${anon}`,
				"Content-Type": "application/json",
				"X-Makkit-Client": CLIENT,
			},
			body: JSON.stringify({ p_key: key, p_fn: fn, p_args: args }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const text = await res.text();

		if (!res.ok) {
			throw new Error(`${fn} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
		}

		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`${fn} answered a body that is not JSON: ${text.slice(0, 300)}`);
		}
	};
}

async function main() {
	const { pages, skipped } = classify(readTagged());

	for (const s of skipped) {
		console.error(`[makkit-docs] skipped ${s.slug}: ${s.why}`);
	}

	if (DRY_RUN) {
		for (const p of pages) {
			console.log(`would reconcile ${p.slug} "${p.title}" ${p.html.length} chars ${p.hash}`);
		}

		console.log(
			`makkit-docs dry run: ${pages.length} page(s) would be compared with Makkit's index, ${skipped.length} skipped. Nothing sent, so retirements are not planned.`,
		);

		return 0;
	}

	const call = agentCaller();
	const index = await call("docs_index", {});

	if (!Array.isArray(index?.docs)) {
		throw new TypeError("docs_index did not return a docs array");
	}

	const remote = new Map(index.docs.map((d) => [d.slug, d.hash]));
	const counts = { published: 0, unchanged: 0, retired: 0, failed: 0 };
	const attempt = async (what, fn, args) => {
		try {
			return await call(fn, args);
		} catch (err) {
			counts.failed += 1;
			console.error(`[makkit-docs] ${what} failed: ${err.message}`);

			return null;
		}
	};

	for (const p of pages) {
		if (remote.get(p.slug) === p.hash) {
			counts.unchanged += 1;

			continue;
		}

		// Calls run one at a time on purpose, so a large sync never floods Makkit.
		// oxlint-disable-next-line no-await-in-loop
		if (await attempt(`publish ${p.slug}`, "docs_publish", p)) {
			counts.published += 1;
		}
	}

	// A page that is tagged but skipped stays where it is; only a page that is no longer a
	// tagged shared page leaves staff.
	const tagged = new Set([...pages, ...skipped].map((p) => p.slug));

	for (const slug of remote.keys()) {
		// oxlint-disable-next-line no-await-in-loop
		if (!tagged.has(slug) && (await attempt(`retire ${slug}`, "docs_retire", { slug }))) {
			counts.retired += 1;
		}
	}

	console.log(
		`makkit-docs sync: published=${counts.published} unchanged=${counts.unchanged} retired=${counts.retired} skipped=${skipped.length} failed=${counts.failed}`,
	);

	return counts.failed ? 1 : 0;
}

try {
	process.exitCode = await main();
} catch (err) {
	console.error(`[makkit-docs] ${err.message}`);
	process.exitCode = 1;
}
