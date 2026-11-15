#!/usr/bin/env node
// Behaviour tests for the public draft slot (/s/<token>/draft) and the /s/ CSP, against a TEMP DB.
//
// Drives the REAL draft route and handler (share-draft.js) with WHATWG Requests, and the REAL
// /s/[token] GET handler for the CSP. Never touches the live DB.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "share-draft-test-"));

process.env.TASKS_DB_PATH = path.join(TMP, "tasks.db");
delete process.env.TASKS_CONFIG;

const {
	default: db,
	countShareDrafts,
	listShareDraftsForSlug,
	SHARE_DRAFT_KEEP,
} = await import("../src/lib/server/db.js");
const { BODY_MAX, handleShareDraft } = await import("../src/lib/server/share-draft.js");
const draftRoute = await import("../src/routes/s/[token]/draft/+server.js");
const shareRoute = await import("../src/routes/s/[token]/+server.js");

const checks = [];

async function t(name, fn) {
	try {
		await fn();
		checks.push({ name, pass: true });
	} catch (error) {
		checks.push({ name, pass: false, detail: error.message });
	}
}

const ORIGIN = "https://tasks.petalcat.dev";
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const token = (name) => `${name}-${"x".repeat(24)}`;

function share(slug, raw, { draft = 0, revoked = 0, expires = null } = {}) {
	return Number(
		db
			.prepare(
				`INSERT INTO artifact_shares (slug, token_hash, created_by, draft_enabled, revoked, expires_at)
         VALUES (@slug, @hash, 'alice', @draft, @revoked, @expires)`,
			)
			.run({ slug, hash: sha256hex(raw), draft, revoked, expires }).lastInsertRowid,
	);
}

db.prepare(
	`INSERT INTO artifacts (slug, title, kind, content) VALUES
   ('essay', 'Essay', 'interactive', '<!doctype html><p>essay'),
   ('notes', 'Notes', 'html', '<!doctype html><p>notes')`,
).run();

const ON = token("on");
const OFF = token("off");
const REVOKED = token("revoked");
const EXPIRED = token("expired");
const HTML = token("html");
const onId = share("essay", ON, { draft: 1 });

share("essay", OFF);
share("essay", REVOKED, { draft: 1, revoked: 1 });
share("essay", EXPIRED, { draft: 1, expires: "2000-01-01 00:00:00" });
share("notes", HTML, { draft: 1 });

// A fake clock that jumps a minute per call, so rate limits only bite where a test holds it still.
let clock = Date.now();
let ipSeq = 0;

async function call(method, raw, body, { ip, now } = {}) {
	clock += 61_000;

	const request = new Request(`${ORIGIN}/s/${raw}/draft`, {
		method,
		body,
		headers: body == null ? {} : { "content-type": "application/json" },
	});
	const r = await handleShareDraft({
		request,
		token: raw,
		ip: ip ?? `10.0.0.${++ipSeq}`,
		now: now ?? clock,
	});

	return { status: r.status, json: r.body ? JSON.parse(r.body) : null, headers: r.headers };
}

const good = { paras: ["First paragraph.", "Second one."], checks: { 1: true } };
const put = (raw, draft = good, opts) => call("PUT", raw, JSON.stringify(draft), opts);
const totalDrafts = () => db.prepare("SELECT count(*) AS n FROM share_drafts").get().n;

// Runs first, on the real clock: later tests drive a fake clock that only moves forward.
await t(
	"the SvelteKit route (real clock, before any save) answers preflight and GET with CORS, no credentials",
	async () => {
		const url = `${ORIGIN}/s/${ON}/draft`;
		const event = (request) => ({
			request,
			params: { token: ON },
			getClientAddress: () => "127.0.0.1",
		});
		const pre = await draftRoute.OPTIONS(event(new Request(url, { method: "OPTIONS" })));

		assert.equal(pre.status, 204);
		assert.match(pre.headers.get("access-control-allow-methods"), /PUT/);

		const got = await draftRoute.GET(
			event(new Request(url, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } })),
		);

		assert.equal(got.status, 200);
		assert.equal(got.headers.get("access-control-allow-origin"), "*");
		assert.equal(got.headers.get("access-control-allow-credentials"), null);
		assert.deepEqual((await got.json()).draft, null);
	},
);

await t("save then load round-trips the draft", async () => {
	const saved = await put(ON);

	assert.equal(saved.status, 200);
	assert.equal(saved.json.ok, true);

	const loaded = await call("GET", ON);

	assert.equal(loaded.status, 200);
	assert.deepEqual(loaded.json.draft, good);
});

for (const [name, raw] of [
	["wrong token", token("nobody")],
	["malformed token", "../../etc"],
	["revoked share", REVOKED],
	["expired share", EXPIRED],
	["draft_enabled=0", OFF],
	["non-interactive artifact", HTML],
]) {
	await t(`${name}: generic 404 on GET and PUT, nothing written`, async () => {
		const before = totalDrafts();
		const got = await call("GET", raw);
		const putr = await put(raw);

		assert.equal(got.status, 404);
		assert.equal(putr.status, 404);
		assert.deepEqual(got.json, { error: "not found" });
		assert.deepEqual(putr.json, { error: "not found" });
		assert.equal(totalDrafts(), before);
	});
}

await t(
	"oversized body: 413 by Content-Length and by streamed bytes, nothing written",
	async () => {
		const before = totalDrafts();
		const big = JSON.stringify({ paras: ["x".repeat(BODY_MAX)] });

		assert.equal((await call("PUT", ON, big)).status, 413);

		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(big));
				controller.close();
			},
		});
		const r = await handleShareDraft({
			request: new Request(`${ORIGIN}/s/${ON}/draft`, {
				method: "PUT",
				body: stream,
				duplex: "half",
			}),
			token: ON,
			ip: "10.9.9.9",
			now: (clock += 61_000),
		});

		assert.equal(r.status, 413);
		assert.equal(totalDrafts(), before);
	},
);

for (const [name, body] of [
	["not JSON", "{nope"],
	["array root", "[]"],
	["missing paras", '{"checks":{}}'],
	["empty paras", '{"paras":[]}'],
	["too many paras", JSON.stringify({ paras: Array.from({ length: 11 }, () => "a") })],
	["non-string para", '{"paras":[1]}'],
	["para too long", JSON.stringify({ paras: ["x".repeat(8001)] })],
	["extra key", '{"paras":["a"],"html":"<b>"}'],
	["bad check key", '{"paras":["a"],"checks":{"x":true}}'],
	["non-boolean check", '{"paras":["a"],"checks":{"1":"yes"}}'],
]) {
	await t(`bad schema (${name}): 400, nothing written`, async () => {
		const before = countShareDrafts(onId);
		const r = await call("PUT", ON, body);

		assert.equal(r.status, 400);
		assert.equal(countShareDrafts(onId), before);
	});
}

await t(`keeps only the newest ${SHARE_DRAFT_KEEP} revisions per share`, async () => {
	for (let i = 0; i < SHARE_DRAFT_KEEP + 7; i++) {
		assert.equal((await put(ON, { paras: [`rev ${i}`] })).status, 200);
	}

	assert.equal(countShareDrafts(onId), SHARE_DRAFT_KEEP);
	assert.deepEqual((await call("GET", ON)).json.draft.paras, [`rev ${SHARE_DRAFT_KEEP + 6}`]);
});

await t("per-share rate limit: 429 even when every request comes from a new IP", async () => {
	const now = (clock += 3_600_000);
	const codes = [];

	for (let i = 0; i < 25; i++) {
		codes.push((await put(ON, good, { now })).status);
	}

	assert.ok(codes.includes(429), codes.join(","));
});

await t("per-IP rate limit: 429 across tokens, including bad ones", async () => {
	const now = (clock += 3_600_000);
	const codes = [];

	for (let i = 0; i < 35; i++) {
		codes.push((await call("GET", token(`probe${i}`), null, { ip: "9.9.9.9", now })).status);
	}

	assert.equal(codes.at(-1), 429);
});

await t("gallery listing returns the latest draft per share, and nothing for others", () => {
	const rows = listShareDraftsForSlug("essay");

	assert.equal(rows.length, 1);
	assert.equal(rows[0].share_id, onId);
	assert.equal(listShareDraftsForSlug("notes").length, 0);
});

// CSP: shares without drafts must be byte-identical to the strings that shipped before drafts.
const PINNED = {
	html: "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'",
	interactive:
		"sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'none'",
};
const cspOf = (raw) =>
	shareRoute
		.GET({ params: { token: raw }, url: new URL(`${ORIGIN}/s/${raw}`) })
		.headers.get("content-security-policy");

await t("/s/ CSP is byte-identical for a share without drafts", () => {
	assert.equal(cspOf(OFF), PINNED.interactive);
	assert.equal(cspOf(HTML), PINNED.html);
});

await t("/s/ CSP for a draft share adds connect-src for its own draft path only", () => {
	assert.equal(cspOf(ON), `${PINNED.interactive}; connect-src ${ORIGIN}/s/${ON}/draft`);
});

await t("/s/ CSP never embeds a token that is not plain base64url", () => {
	const odd = "odd;token-with-a-semicolon-xx";

	share("essay", odd, { draft: 1 });
	assert.equal(cspOf(odd), PINNED.interactive);
});

let failed = 0;

for (const c of checks) {
	console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : `  — ${c.detail}`}`);

	if (!c.pass) {
		failed++;
	}
}

console.log(`\n${checks.length - failed}/${checks.length} passed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
