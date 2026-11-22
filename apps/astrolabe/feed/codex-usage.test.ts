import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

/** A home directory that is also first on PATH, so a file named `codex` in it is the Codex CLI. */
const host = () => {
	const home = mkdtempSync(path.join(tmpdir(), "codex-usage-"));

	onTestFinished(() => {
		rmSync(home, { recursive: true });
	});

	return home;
};

const run = (home: string, env: Record<string, string> = {}) => {
	const started = performance.now();
	const result = spawnSync(
		process.execPath,
		[path.join(import.meta.dirname, "codex-usage.ts"), "--json"],
		{
			env: { PATH: `${home}:${process.env.PATH ?? ""}`, HOME: home, ...env },
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	const snapshot: unknown = JSON.parse(result.stdout);

	return { snapshot, warning: result.stderr, seconds: (performance.now() - started) / 1000 };
};

// Each test starts Node once more, which a loaded runner takes seconds over.
describe("codex-usage --json", { timeout: 30_000 }, () => {
	it("reads the limits live from a server that answers and then stays up", () => {
		const home = host();
		const limits = {
			primary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_793_774_155 },
			secondary: null,
			credits: { hasCredits: true, balance: "12.5" },
			planType: "prolite",
			rateLimitReachedType: null,
		};
		const replies = [
			{ id: 1, result: {} },
			{ id: 2, result: { rateLimits: limits } },
		]
			.map((reply) => `'${JSON.stringify(reply)}'`)
			.join(" ");

		// Reads the three requests, answers both in one write, then stays alive as app-server does.
		writeFileSync(
			path.join(home, "codex"),
			`#!/bin/sh\nread -r a; read -r b; read -r c\nprintf '%s\\n' ${replies}\nexec sleep 60\n`,
			{ mode: 0o755 },
		);

		const { snapshot, seconds } = run(home);

		// The only window is a week long, so it is the weekly one though it came as `primary`.
		expect(snapshot).toMatchObject({
			five_hour_pct: null,
			five_hour_resets_at: null,
			seven_day_pct: 42,
			seven_day_resets_at: 1_793_774_155,
			plan: "prolite",
			snapshot_age_sec: 0,
			awaiting: false,
			credits_balance: 12.5,
			has_credits: true,
			rate_limit_reached_type: null,
		});

		expect(seconds).toBeLessThan(10);
	});

	it("falls back to the last limits in the newest rollout that records any, and says so", () => {
		const home = host();
		const sessions = path.join(home, ".codex", "sessions", "2026", "11", "20");
		const now = Date.now() / 1000;
		const rollout = (name: string, ageSeconds: number, lines: unknown[]) => {
			const file = path.join(sessions, name);

			writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
			utimesSync(file, now - ageSeconds, now - ageSeconds);
		};

		mkdirSync(sessions, { recursive: true });
		rollout("newest.jsonl", 10, [{ payload: { text: "a turn that records no limits" } }]);

		rollout("hour-old.jsonl", 3600, [
			{ payload: { rate_limits: { primary: { used_percent: 1, window_minutes: 300 } } } },
			{
				payload: [
					{ rate_limits: { primary: { used_percent: 2, window_minutes: 300 } } },
					{
						info: {
							rate_limits: {
								primary: { used_percent: 95.5, window_minutes: 300, resets_at: 1_795_000_000.7 },
								secondary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_795_500_000 },
								credits: { balance: "0", has_credits: false },
								plan_type: "plus",
							},
						},
					},
				],
			},
		]);

		rollout("older.jsonl", 7200, [
			{ rate_limits: { primary: { used_percent: 77, window_minutes: 300 } } },
		]);

		const { snapshot, warning } = run(home, { CODEX_BIN: path.join(home, "not-installed") });

		expect(snapshot).toMatchObject({
			five_hour_pct: 95.5,
			five_hour_resets_at: 1_795_000_000,
			seven_day_pct: 40,
			seven_day_resets_at: 1_795_500_000,
			plan: "plus",
			awaiting: false,
			credits_balance: 0,
			has_credits: false,
			rate_limit_reached_type: null,
		});

		// The figures are as old as the rollout that holds them, not as new as the newest rollout.
		expect(snapshot).toHaveProperty("snapshot_age_sec", expect.closeTo(3600, -2));
		expect(warning).toContain("using rollouts");
	});
});
