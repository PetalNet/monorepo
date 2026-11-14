#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { renderMd } from "../src/lib/server/md.js";

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
// html and interactive pages go as stored. Markdown pages are rendered with the web app's own
// renderMd (sanitized) and wrapped in a self-contained document, so Makkit's reader, which serves
// docs under default-src 'none'; style-src 'unsafe-inline', needs nothing external.

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
				`SELECT slug, title, description, kind, content FROM artifacts
         WHERE collection='makkit' AND visibility='shared' ORDER BY slug`,
			)
			.all();
	} finally {
		db.close();
	}
}

const escapeHtml = (s) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

// Mirrors the tasks gallery's markdown view (app.css .prose): same type scale, spacing and paper
// and ink palettes, with system fonts because the reader allows no external resources.
const DOC_CSS = `
:root{color-scheme:light dark;--bg:#fff;--s1:#fbfaf9;--s2:#f6f5f3;--rule:#ececea;--t1:#161412;--t2:#3a3631;--t3:#4a4642;--ac:#bc5638;--acb:#a14a30;--acl:rgba(188,86,56,.3)}
@media (prefers-color-scheme:dark){:root{--bg:#0d0c0b;--s1:#161413;--s2:#1d1b19;--rule:#262321;--t1:#ece8e3;--t2:#c4beb6;--t3:#bdb9b4;--ac:#e2725b;--acb:#ec8a76;--acl:rgba(226,114,91,.34)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--t2);font:15.5px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
header h1{font-size:28px;font-weight:700;letter-spacing:-.02em;color:var(--t1);margin:0 0 6px;line-height:1.25}
.sub{color:var(--t3);margin:0 0 8px}
h1,h2,h3,h4{color:var(--t1);line-height:1.3}
article h1{font-size:24px;font-weight:700;margin:26px 0 8px;letter-spacing:-.02em}
h2{font-size:18px;font-weight:600;margin:26px 0 8px;color:var(--acb);border-bottom:1px solid var(--rule);padding-bottom:6px}
h3{font-size:15px;font-weight:600;margin:20px 0 6px}
p,ul,ol,blockquote{margin:9px 0}
ul,ol{padding-left:24px}
li{margin:5px 0}
strong{color:var(--t1);font-weight:600}
a{color:var(--acb);text-decoration:underline;text-decoration-color:var(--acl);text-underline-offset:3px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--s2);padding:1px 6px;border-radius:5px;color:var(--acb);border:1px solid var(--rule)}
pre{background:var(--s1);border:1px solid var(--rule);border-radius:12px;padding:12px 14px;overflow-x:auto;margin:12px 0}
pre code{background:none;border:0;padding:0;color:var(--t2);font-size:12.5px;line-height:1.5}
blockquote{border-left:3px solid var(--ac);padding-left:15px;color:var(--t3);font-style:italic}
hr{border:0;border-top:1px solid var(--rule);margin:26px 0}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13px;display:block;overflow-x:auto}
th,td{border:1px solid var(--rule);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--s2);color:var(--t1);font-weight:600;white-space:nowrap}
img{max-width:100%}
.wikilink{font-size:.92em;padding:1px 7px;border-radius:5px;white-space:nowrap;border:1px solid var(--rule);background:var(--s2);text-decoration:none}
`
	.trim()
	.replaceAll("\n", "");

function markdownDocument(r) {
	const sub = r.description ? `<p class="sub">${escapeHtml(r.description)}</p>` : "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(r.title)}</title>
<style>${DOC_CSS}</style>
</head>
<body>
<main>
<header><h1>${escapeHtml(r.title)}</h1>${sub}</header>
<article>${renderMd(r.content)}</article>
</main>
</body>
</html>
`;
}

function skipReason(r, html) {
	if (!SLUG_RE.test(r.slug)) {
		return "invalid slug";
	}

	if (!r.title || r.title.length > MAX_TITLE) {
		return `title must be 1 to ${MAX_TITLE} characters`;
	}

	if (html.length > MAX_HTML) {
		return `html is over ${MAX_HTML} characters`;
	}

	return null;
}

// Split tagged pages into those we can push and those we skip, with the reason for each skip.
function classify(rows) {
	const pages = [];
	const skipped = [];

	for (const r of rows) {
		const html = r.kind === "markdown" ? markdownDocument(r) : r.content;
		const why = skipReason(r, html);

		if (why) {
			skipped.push({ slug: r.slug, why });
		} else {
			pages.push({
				slug: r.slug,
				title: r.title,
				html,
				hash: sha256(`${r.title}\n${html}`),
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

	// The agent key travels in the request body, so it never leaves over cleartext HTTP. Plain
	// http is allowed only for a loopback stand-in.
	const { protocol, hostname } = new URL(base);

	if (protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
		throw new Error("MAKKIT_API_URL must be https (http only for localhost)");
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
