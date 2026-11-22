import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it, onTestFinished } from "vitest";

const runFetcher = (config: string, status = 200) => {
	const home = mkdtempSync(path.join(tmpdir(), "usage-fetch-"));

	onTestFinished(() => {
		rmSync(home, { recursive: true });
	});

	mkdirSync(path.join(home, ".config/claude-matrix-channel"), { recursive: true });
	writeFileSync(path.join(home, ".config/claude-matrix-channel/usage.toml"), config);
	const raw = path.join(home, "raw.json");
	const preload = path.join(home, "fetch.mjs");
	const body = {
		five_hour: null,
		seven_day: { utilization: 71, resets_at: "2026-11-24T10:00:00+00:00" },
	};

	writeFileSync(
		preload,
		`
		import assert from 'node:assert/strict';
		globalThis.fetch = async (url, { headers }) => {
			assert.equal(url, 'https://claude.ai/api/organizations/test-org/usage');
			assert.equal(headers.Cookie, 'sessionKey=test-secret');
			assert.equal(headers.Referer, 'https://claude.ai/settings/usage');
			assert.equal(headers.Origin, 'https://claude.ai');
			assert.equal(headers['Sec-Fetch-Site'], 'same-origin');
			return new Response(JSON.stringify(${JSON.stringify(body)}), {status: ${String(status)}});
		};
	`,
	);

	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(preload).href, path.join(import.meta.dirname, "usage-fetch.ts")],
		{
			env: { HOME: home, CLAUDE_USAGE_RAW_OUT: raw },
			encoding: "utf8",
			timeout: 30_000,
		},
	);

	return { result, raw: existsSync(raw) ? readFileSync(raw, "utf8") : null, body };
};

it("writes the full usage response to stdout and the raw feed without credentials", () => {
	const { result, raw, body } = runFetcher('session_key = "test-secret"\norg_id = "test-org"\n');

	expect(result.status).toBe(0);
	expect(result.stdout).toBe(JSON.stringify(body));
	expect(raw).toBe(JSON.stringify(body, null, 2));
	expect(result.stdout + result.stderr + (raw ?? "")).not.toContain("test-secret");
});

it("fails without publishing when configuration is incomplete", () => {
	const { result, raw } = runFetcher('org_id = "test-org"\n');

	expect(result.status).toBe(2);
	expect(result.stderr).toContain("missing session_key or org_id");
	expect(result.stdout).toBe("");
	expect(raw).toBeNull();
});

it("fails without publishing an HTTP error response", () => {
	const { result, raw } = runFetcher('session_key = "test-secret"\norg_id = "test-org"\n', 401);

	expect(result.status).toBe(2);
	expect(result.stderr).toContain("HTTP 401");
	expect(result.stdout).toBe("");
	expect(raw).toBeNull();
});
