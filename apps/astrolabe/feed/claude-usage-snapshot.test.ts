import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

/** Runs the script on a host whose login holds `credentials`; returns the written and pushed copies. */
const snapshot = (credentials: Record<string, unknown> | null) => {
	const home = mkdtempSync(path.join(tmpdir(), "claude-usage-"));
	const pushed = path.join(home, "pushed.json");
	const out = path.join(home, "janet-usage.json");

	onTestFinished(() => {
		rmSync(home, { recursive: true });
	});

	// Stands in for `node usage-fetch.js`: a usage response with no 5-hour window.
	writeFileSync(
		path.join(home, "node"),
		`#!/bin/sh\necho '{"five_hour": null, "seven_day": {"utilization": 71, "resets_at": "2026-11-24T10:00:00+00:00"}}'\n`,
		{ mode: 0o755 },
	);

	// Stands in for the push to the agent VM, and keeps what it was sent.
	writeFileSync(path.join(home, "ssh"), `#!/bin/sh\ncat > '${pushed}'\n`, { mode: 0o755 });

	if (credentials !== null) {
		mkdirSync(path.join(home, ".claude"));
		writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify(credentials));
	}

	const result = spawnSync(
		process.execPath,
		[path.join(import.meta.dirname, "claude-usage-snapshot.ts")],
		{
			env: { PATH: `${home}:${process.env.PATH ?? ""}`, HOME: home, CLAUDE_USAGE_OUT: out },
			encoding: "utf8",
			timeout: 60_000,
		},
	);

	expect(result.status).toBe(0);

	return { written: readFileSync(out, "utf8"), pushed: readFileSync(pushed, "utf8") };
};

// Each test starts Node once more, which a loaded runner takes seconds over.
describe("claude-usage-snapshot", { timeout: 30_000 }, () => {
	it("carries the login's plan and never its tokens", () => {
		const { written, pushed } = snapshot({
			claudeAiOauth: {
				accessToken: "access-token-value",
				refreshToken: "refresh-token-value",
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
		});

		expect(JSON.parse(written)).toMatchObject({
			subscription_type: "max",
			rate_limit_tier: "default_claude_max_20x",
			seven_day_pct: 71,
			raw: { five_hour: null },
		});

		expect(pushed).toBe(written);
		expect(written).not.toContain("token-value");
	});

	it("writes the snapshot without a login", () => {
		expect(JSON.parse(snapshot(null).written)).toMatchObject({
			subscription_type: null,
			rate_limit_tier: null,
			seven_day_pct: 71,
		});
	});
});
