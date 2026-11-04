#!/usr/bin/env node
// Behaviour tests for the public scoped-share path against a TEMP DB.
//
// Drives the REAL access hook (src/hooks.server.js handle) and the REAL /s/[token] GET
// handler. The share link must work with no SSO identity, every other page must refuse a
// missing or unknown identity, and a share token must open exactly one live artifact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Both modules read their environment at import time.
const TMP = mkdtempSync(path.join(tmpdir(), "public-share-test-"));

process.env.TASKS_DB_PATH = path.join(TMP, "tasks.db");
process.env.ALLOW = "alice";
delete process.env.TASKS_CONFIG;

const { default: db } = await import("../src/lib/server/db.js");
const { handle } = await import("../src/hooks.server.js");
const { GET } = await import("../src/routes/s/[token]/+server.js");

const checks = [];

async function t(name, fn) {
	try {
		await fn();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

// Runs one request through the hook. `resolve` stands in for the route: it records that the
// request got past the gate and which identity it carried.
async function through(pathname, user) {
	const url = new URL(pathname, "http://tasks.test");
	const headers = user ? { "x-authentik-username": user } : {};
	const event = { url, request: new Request(url, { headers }), locals: {} };
	let reached = false;
	const response = await handle({
		event,
		resolve: () => {
			reached = true;

			return new Response("route");
		},
	});

	return { status: response.status, reached, user: event.locals.user };
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

function share(slug, token, extra = "") {
	db.prepare(
		`INSERT INTO artifact_shares (slug, token_hash, created_by${extra ? `, ${extra}` : ""})
     VALUES (@slug, @hash, 'alice'${extra ? ", 1" : ""})`,
	).run({ slug, hash: sha256hex(token) });
}

function status(fn) {
	try {
		return fn().status;
	} catch (error) {
		return error.status;
	}
}

db.prepare(
	`INSERT INTO artifacts (slug, title, kind, content) VALUES
   ('shared-doc', 'Shared doc', 'markdown', '# Hello\n\nbody text\n\n<script>alert(1)</script>'),
   ('other-doc', 'Other doc', 'markdown', 'secret other content')`,
).run();

share("shared-doc", "good-token");
share("shared-doc", "revoked-token", "revoked");

db.prepare(
	`INSERT INTO artifact_shares (slug, token_hash, created_by, expires_at)
   VALUES ('shared-doc', @hash, 'alice', datetime('now', '-1 hour'))`,
).run({ hash: sha256hex("expired-token") });

await t("a share path passes the SSO gate without an identity", async () => {
	const r = await through("/s/good-token");

	assert.equal(r.reached, true);
	assert.equal(r.status, 200);
});

await t("other pages refuse a request with no identity", async () => {
	const r = await through("/");

	assert.equal(r.reached, false);
	assert.equal(r.status, 403);
});

await t("other pages refuse an identity outside ALLOW", async () => {
	const r = await through("/gallery", "mallory");

	assert.equal(r.reached, false);
	assert.equal(r.status, 403);
});

await t("an allowed identity reaches the page and is recorded", async () => {
	const r = await through("/gallery", "alice");

	assert.equal(r.reached, true);
	assert.equal(r.user, "alice");
});

await t("the exemption is the /s prefix only, not lookalikes", async () => {
	const r = await through("/share/good-token");

	assert.equal(r.reached, false);
	assert.equal(r.status, 403);
});

await t("a valid token renders its artifact, sanitized, with hardening headers", async () => {
	const response = GET({ params: { token: "good-token" } });
	const html = await response.text();

	assert.equal(response.status, 200);
	assert.match(html, /Shared doc/);
	assert.match(html, /body text/);
	assert.doesNotMatch(html, /<script>alert/);
	assert.doesNotMatch(html, /secret other content/);
	assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
});

await t("unknown, revoked and expired tokens all 404", () => {
	assert.equal(
		status(() => GET({ params: { token: "nope" } })),
		404,
	);

	assert.equal(
		status(() => GET({ params: { token: "revoked-token" } })),
		404,
	);

	assert.equal(
		status(() => GET({ params: { token: "expired-token" } })),
		404,
	);
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
