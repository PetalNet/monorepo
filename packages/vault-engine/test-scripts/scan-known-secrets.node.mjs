import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("../scripts/scan-known-secrets.mjs", import.meta.url));
const secret = "synthetic-secret-73824";
const run = (manifest, dump = JSON.stringify({ example: secret })) =>
	spawnSync(process.execPath, [scanner, manifest], { input: dump, encoding: "utf8" });

test("scans all manifest values and document text without disclosing matches", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "vault-scan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const manifest = path.join(dir, "manifest.jsonl");
	const doc = path.join(dir, "note.md");
	const write = (entry) => writeFileSync(manifest, JSON.stringify(entry) + "\n");
	writeFileSync(doc, "ordinary document");
	write({ type: "document", file: doc, title: "ordinary" });
	assert.equal(run(manifest).status, 0);
	for (const entry of [
		{ type: "document", file: doc, title: `before ${secret} after` },
		{ type: "capture", refs: [{ [secret]: "value" }] },
	]) {
		write(entry);
		const result = run(manifest);
		assert.equal(result.status, 1);
		assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
	}
	writeFileSync(
		manifest,
		JSON.stringify({ type: "capture", excerpt: secret }).replace(
			secret,
			"\\u0073" + secret.slice(1),
		),
	);
	assert.equal(run(manifest).status, 1);
	write({ type: "document", file: doc });
	writeFileSync(doc, `before ${secret} after`);
	assert.equal(run(manifest).status, 1);
	writeFileSync(doc, "a line from a multi-line secret");
	assert.equal(
		run(manifest, JSON.stringify({ example: "other line\na line from a multi-line secret" }))
			.status,
		1,
	);
});

test("fails closed for missing, empty, malformed, or unreadable inputs", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "vault-scan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const manifest = path.join(dir, "manifest.jsonl");
	writeFileSync(manifest, JSON.stringify({ type: "capture" }));
	for (const dump of ["", "{", "{}", "[]", '{"a":null}', '{"a":""}']) {
		assert.equal(run(manifest, dump).status, 1);
	}
	assert.equal(run(path.join(dir, "missing")).status, 1);
	writeFileSync(manifest, "\n");
	assert.equal(run(manifest).status, 1);
	writeFileSync(manifest, "not json");
	assert.equal(run(manifest).status, 1);
	writeFileSync(manifest, JSON.stringify({ type: "document", file: path.join(dir, "missing") }));
	assert.equal(run(manifest).status, 1);
});
