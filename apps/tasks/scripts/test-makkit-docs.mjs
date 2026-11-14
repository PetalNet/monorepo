#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

// Behaviour tests for the artifacts.collection column and scripts/sync-makkit-docs.mjs.
// The sync runs as cron runs it (a child process) against a TEMP DB, talking to a local HTTP
// server that stands in for Makkit's agent_call contract (docs_index, docs_publish, docs_retire).

const TMP = mkdtempSync(path.join(tmpdir(), "makkit-docs-test-"));
const DB_PATH = path.join(TMP, "tasks.db");
const KEY_FILE = path.join(TMP, "agent.key");
const SYNC = path.resolve(import.meta.filename, "../sync-makkit-docs.mjs");
const DB_JS = path.resolve(import.meta.filename, "../../src/lib/server/db.js");
const KEY = "agent-key-secret";
const ANON = "anon-key";

writeFileSync(KEY_FILE, `${KEY}\n`);

process.env.TASKS_DB_PATH = DB_PATH;
delete process.env.TASKS_CONFIG;

const { default: db } = await import("../src/lib/server/db.js");

const sha = (s) => createHash("sha256").update(s).digest("hex");
const page = (slug, title, content, fields = {}) =>
	db
		.prepare(
			`INSERT INTO artifacts (slug, title, kind, content, visibility, collection)
       VALUES (@slug, @title, @kind, @content, @visibility, @collection)`,
		)
		.run({ slug, title, content, kind: "html", visibility: "shared", collection: "", ...fields });
const collectionOf = (slug) =>
	db.prepare("SELECT collection FROM artifacts WHERE slug=?").get(slug).collection;

const checks = [];

async function t(name, fn) {
	try {
		await fn();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

// --- the column -------------------------------------------------------------

page("plain", "Plain", "<p>plain</p>");

await t("a page published without a collection has none", () =>
	assert.equal(collectionOf("plain"), ""),
);

await t("a column added to an existing DB leaves old rows with no collection", async () => {
	const old = path.join(TMP, "old.db");
	const raw = new Database(old);

	raw.exec(`CREATE TABLE artifacts (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'markdown', content TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'shared');
    INSERT INTO artifacts (slug, title, content) VALUES ('legacy', 'Legacy', 'x')`);

	raw.close();

	const code = await run(
		process.execPath,
		["--input-type=module", "-e", `await import(${JSON.stringify(DB_JS)})`],
		{
			TASKS_DB_PATH: old,
		},
	);

	assert.equal(code.status, 0, code.stderr);

	const after = new Database(old, { readonly: true });

	assert.equal(
		after.prepare("SELECT collection FROM artifacts WHERE slug='legacy'").get().collection,
		"",
	);

	after.close();
});

await t("an update that omits the collection leaves it alone", () => {
	page("kept", "Kept", "<p>a</p>", { collection: "makkit" });
	db.prepare("UPDATE artifacts SET title='Kept v2', content='<p>b</p>' WHERE slug='kept'").run();
	assert.equal(collectionOf("kept"), "makkit");
});

await t("an update can clear the collection with ''", () => {
	db.prepare("UPDATE artifacts SET collection='' WHERE slug='kept'").run();
	assert.equal(collectionOf("kept"), "");
});

await t("a collection that is not a short lowercase slug is refused", () => {
	for (const bad of ["Makkit", "has space", "-lead", "a/b", "x".repeat(33), "über"]) {
		assert.throws(
			() => db.prepare("UPDATE artifacts SET collection=? WHERE slug='plain'").run(bad),
			/CHECK constraint/,
			`accepted ${JSON.stringify(bad)}`,
		);
	}

	db.prepare("UPDATE artifacts SET collection=? WHERE slug='plain'").run("x".repeat(32));
	db.prepare("UPDATE artifacts SET collection='' WHERE slug='plain'").run();
});

// --- the sync ---------------------------------------------------------------

function makkitStandIn() {
	const docs = new Map();
	const state = { calls: [], mode: "ok" };
	const server = createServer((req, res) => {
		let body = "";

		req.on("data", (c) => (body += c));

		req.on("end", () => {
			const send = (status, json) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(json));
			};

			const h = req.headers;

			if (!h["x-makkit-client"]) {
				return send(426, { code: "client_update_required" });
			}

			if (req.url !== "/rest/v1/rpc/agent_call" || req.method !== "POST") {
				return send(404, {});
			}

			if (h.apikey !== ANON || h.authorization !== `Bearer ${ANON}`) {
				return send(401, { message: "bad anon key" });
			}

			const { p_key, p_fn, p_args } = JSON.parse(body);

			if (p_key !== KEY) {
				return send(400, { message: "bad agent key" });
			}

			state.calls.push({ fn: p_fn, args: p_args });

			if (state.mode === "error" && p_fn !== "docs_index") {
				return send(500, { message: "boom" });
			}

			if (state.mode === "index-error") {
				return send(500, { message: "boom" });
			}

			if (p_fn === "docs_index") {
				return send(200, { docs: [...docs].map(([slug, d]) => ({ slug, hash: d.hash })) });
			}

			if (p_fn === "docs_publish") {
				const { slug, title, html, hash } = p_args;

				assert.equal(hash, sha(`${title}\n${html}`), "hash is sha256(title\\nhtml)");

				const changed = docs.get(slug)?.hash !== hash;

				docs.set(slug, { title, html, hash });

				return send(200, { slug, changed });
			}

			if (p_fn === "docs_retire") {
				return send(200, { slug: p_args.slug, retired: docs.delete(p_args.slug) });
			}

			return send(400, { message: "unknown fn" });
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, docs, state, url: `http://127.0.0.1:${server.address().port}` });
		});
	});
}

function run(cmd, args, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { env: { ...process.env, ...env } });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

const standIn = await makkitStandIn();
const sync = (args = [], env = {}) =>
	run(process.execPath, [SYNC, ...args], {
		TASKS_DB_PATH: DB_PATH,
		MAKKIT_API_URL: standIn.url,
		MAKKIT_ANON_KEY: ANON,
		MAKKIT_AGENT_KEY_FILE: KEY_FILE,
		...env,
	});
const changingCalls = () => standIn.state.calls.filter((c) => c.fn !== "docs_index");

page("roadmap", "Roadmap", "<h1>Roadmap</h1>", { collection: "makkit" });
page("pricing", "Pricing", "<h1>Pricing</h1>", { collection: "makkit" });
page("secret-plan", "Secret", "<h1>Secret</h1>", { collection: "makkit", visibility: "private" });
page("lab-notes", "Lab notes", "<h1>Lab</h1>", { collection: "lab" });

await t("--dry-run prints the plan and sends nothing", async () => {
	const r = await sync(["--dry-run"], { MAKKIT_AGENT_KEY_FILE: "", MAKKIT_API_URL: "" });

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /roadmap/);
	assert.match(r.stdout, /pricing/);
	assert.doesNotMatch(r.stdout, /secret-plan|lab-notes|plain/);
	assert.equal(standIn.state.calls.length, 0);
});

await t("the first run publishes tagged shared pages and nothing else", async () => {
	const r = await sync();

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /published=2 unchanged=0 retired=0 skipped=0 failed=0/);

	assert.deepEqual(
		[...standIn.docs.keys()].toSorted((a, b) => a.localeCompare(b)),
		["pricing", "roadmap"],
	);

	assert.equal(standIn.docs.get("roadmap").html, "<h1>Roadmap</h1>");
});

await t("the second run makes no changing call", async () => {
	standIn.state.calls.length = 0;

	const r = await sync();

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /published=0 unchanged=2 retired=0/);
	assert.deepEqual(changingCalls(), []);
});

await t("an edited page is republished and the others are not", async () => {
	db.prepare("UPDATE artifacts SET content='<h1>Roadmap v2</h1>' WHERE slug='roadmap'").run();
	standIn.state.calls.length = 0;

	const r = await sync();

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /published=1 unchanged=1 retired=0/);

	assert.deepEqual(
		changingCalls().map((c) => [c.fn, c.args.slug]),
		[["docs_publish", "roadmap"]],
	);

	assert.equal(standIn.docs.get("roadmap").html, "<h1>Roadmap v2</h1>");
});

await t("a page made private, untagged or deleted is retired", async () => {
	db.prepare("UPDATE artifacts SET visibility='private' WHERE slug='roadmap'").run();

	let r = await sync();

	assert.match(r.stdout, /retired=1/);
	assert.deepEqual([...standIn.docs.keys()], ["pricing"]);

	db.prepare("UPDATE artifacts SET collection='' WHERE slug='pricing'").run();
	r = await sync();
	assert.match(r.stdout, /retired=1/);
	assert.equal(standIn.docs.size, 0);

	db.prepare("UPDATE artifacts SET collection='makkit' WHERE slug='pricing'").run();
	await sync();
	assert.equal(standIn.docs.size, 1);
	db.prepare("DELETE FROM artifacts WHERE slug='pricing'").run();
	r = await sync();
	assert.match(r.stdout, /retired=1/);
	assert.equal(standIn.docs.size, 0);
});

await t("markdown, oversized and badly named pages are skipped and reported", async () => {
	page("md-page", "Markdown", "# hi", { collection: "makkit", kind: "markdown" });
	page("huge", "Huge", "x".repeat(2_000_001), { collection: "makkit" });
	page("Bad_Slug", "Bad", "<p>bad</p>", { collection: "makkit" });
	page("fine", "Fine", "<p>fine</p>", { collection: "makkit" });

	const r = await sync();

	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /published=1 unchanged=0 retired=0 skipped=3 failed=0/);
	assert.match(r.stderr, /skipped huge/);
	assert.match(r.stderr, /skipped Bad_Slug: invalid slug/);
	assert.match(r.stderr, /skipped md-page/);
	assert.deepEqual([...standIn.docs.keys()], ["fine"]);
});

await t("a server error on a write exits non-zero", async () => {
	db.prepare("UPDATE artifacts SET content='<p>fine 2</p>' WHERE slug='fine'").run();
	standIn.state.mode = "error";

	const r = await sync();

	assert.notEqual(r.status, 0);
	assert.match(r.stdout, /failed=1/);
	assert.match(r.stderr, /HTTP 500/);
});

await t("a server error on the index exits non-zero and changes nothing", async () => {
	standIn.state.mode = "index-error";
	standIn.state.calls.length = 0;

	const r = await sync();

	assert.notEqual(r.status, 0);
	assert.deepEqual(changingCalls(), []);
});

await t("a wrong agent key exits non-zero", async () => {
	standIn.state.mode = "ok";

	const wrong = path.join(TMP, "wrong.key");

	writeFileSync(wrong, "nope");

	const r = await sync([], { MAKKIT_AGENT_KEY_FILE: wrong });

	assert.notEqual(r.status, 0);
	assert.doesNotMatch(r.stdout + r.stderr, /nope|agent-key-secret/);
});

await t("a cleartext non-loopback URL is refused before the key is read or sent", async () => {
	const before = standIn.state.calls.length;
	const r = await sync([], { MAKKIT_API_URL: "http://makkit.example.test" });

	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /must be https/);
	assert.equal(standIn.state.calls.length, before);
});

await t("missing config exits non-zero", async () => {
	const r = await sync([], { MAKKIT_ANON_KEY: "" });

	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /MAKKIT_ANON_KEY/);
});

await t("recovers once the server does: the failed edit is published", async () => {
	const r = await sync();

	assert.equal(r.status, 0, r.stderr);
	assert.equal(standIn.docs.get("fine").html, "<p>fine 2</p>");
});

standIn.server.close();
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
