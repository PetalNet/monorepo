import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOutboundScanner } from "../src/outbound-scan.ts";

const phrase = "amber orchard lantern twelve";
const provider = path.join(import.meta.dirname, "fake-secret-provider.ts");
const cli = path.join(import.meta.dirname, "../src/scan-cli.ts");
const env = {
	...process.env,
	VAULT_SECRET_PROVIDER_ARGV: JSON.stringify([process.execPath, provider]),
	VAULT_SECRET_POLICY: undefined,
};
const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const policy = (text: string) => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "scan-policy-"));
	const file = path.join(dir, "policy.json");

	made.push(dir);
	writeFileSync(file, text);

	return file;
};

const run = (input: string | Buffer, extra: NodeJS.ProcessEnv = {}) =>
	spawnSync(process.execPath, [cli], {
		input,
		env: { ...env, ...extra },
		encoding: "utf8",
		timeout: 20_000,
	});

// CLI probes allow 20 seconds for their child process before reporting a timeout.
describe("outbound scanner", { timeout: 25_000 }, () => {
	it("allows ordinary text and emits no candidate, including on success", () => {
		const result = run("Glaze firing starts at noon.");

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it.each([
		phrase,
		"violet river window nine",
		"https://reader:aaaaaaa@example.org",
		"https://example.org/?session=aaaaaaa",
		"https://example.org/#credential",
		"first synthetic line\nsecond synthetic line",
	])("refuses an exact known value without reporting its entry or text: %s", (value) => {
		const result = run(`A note containing ${value}.`);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe('{"rules":["known-secret"]}\n');
	});

	it("still applies the rule scan to values the provider did not supply", () => {
		const result = run(["-----BEGIN", "PRIVATE KEY-----"].join(" "));

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe('{"rules":["private-key"]}\n');
	});

	it("skips short values, paths and plain URLs by default", async () => {
		const scan = await loadOutboundScanner(env);

		expect(scan(["tiny /var/lib/example/settings https://example.org/documentation"])).toEqual([]);
		expect(scan(["amber orchard lantern twelv"])).toEqual([]);
	});

	it("supports private entry and field skips and disabling shape skips", async () => {
		const scan = await loadOutboundScanner({
			...env,
			VAULT_SECRET_POLICY: policy(
				JSON.stringify({
					skipEntries: ["privateEntry"],
					skipFields: [{ entry: "structured", field: "label" }],
					skipShortValues: false,
					skipPaths: false,
					skipUrls: false,
				}),
			),
		});

		expect(scan([`${phrase} public application label`])).toEqual([]);
		expect(scan(["violet river window nine"])).toEqual(["known-secret"]);

		for (const text of ["tiny", "/var/lib/example/settings", "https://example.org/documentation"]) {
			expect(scan([text])).toEqual(["known-secret"]);
		}
	});

	it.each(["fail", "invalid", "schema", "empty", "empty-fields", "large"])(
		"fails closed with a safe diagnostic for provider mode %s",
		(mode) => {
			const result = run(phrase, { TEST_PROVIDER_MODE: mode });

			expect(result.status).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe('{"error":"scanner-unavailable"}\n');
		},
	);

	it("kills a stalled provider and refuses the candidate", () => {
		const result = run(phrase, { TEST_PROVIDER_MODE: "hang" });

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe('{"error":"scanner-unavailable"}\n');
	}, 25_000);

	it.each([undefined, "", "[]", '["/missing/provider"]', '["node",12]', '"node"'])(
		"fails closed for missing or invalid argv: %s",
		(argv) => {
			const result = run(phrase, { VAULT_SECRET_PROVIDER_ARGV: argv });

			expect(result.status).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe('{"error":"scanner-unavailable"}\n');
		},
	);

	it.each([
		"not-json",
		'{"unknown":true}',
		'{"skipEntries":"privateEntry"}',
		'{"skipFields":[{"entry":"privateEntry"}]}',
	])("fails closed on malformed private policy: %s", (text) => {
		const result = run(phrase, { VAULT_SECRET_POLICY: policy(text) });

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe('{"error":"scanner-unavailable"}\n');
	});

	it.each([Buffer.from([0xff]), Buffer.alloc(17 * 1024 * 1024, "x")])(
		"refuses malformed UTF-8 or oversized stdin",
		(input) => {
			const result = run(input);

			expect(result.status).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe('{"error":"scanner-unavailable"}\n');
		},
	);
});
