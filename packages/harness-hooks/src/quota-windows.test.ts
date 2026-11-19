import { describe, expect, it } from "vitest";

import type { ServiceReport } from "./quota-sources.ts";
import {
	parseAgyQuota,
	parseClaudeUsageJson,
	parseClaudeUsageText,
	parseCodexRateLimits,
	sourceConfigFromEnv,
} from "./quota-sources.ts";
import type { WatchDeps, WatchState } from "./quota-watch.ts";
import { runCheck } from "./quota-watch.ts";

const BEFORE_MIDNIGHT = Date.parse("2026-11-19T23:59:00Z");
const AFTER_MIDNIGHT = Date.parse("2026-11-20T00:01:00Z");

function watcher() {
	let state: WatchState = { version: 1, limits: {} };
	const keys: string[] = [];
	const config = {
		stateFile: "/virtual/quota-state.json",
		injectCommand: "/virtual/inject",
		thresholds: [88, 98],
		source: sourceConfigFromEnv({ HOME: "/nonexistent" }),
	};
	const check = (report: ServiceReport, now: number) => {
		const deps: WatchDeps = {
			now: () => now,
			readServices: () => Promise.resolve([report]),
			inject: (_prompt, _source, key) => {
				keys.push(key);

				return { ok: true, output: "queued" };
			},
			stateExists: () => true,
			loadState: () => state,
			saveState: (_path, next) => {
				state = next;
			},
		};

		return runCheck(config, deps);
	};

	return { check, keys, getState: () => state };
}

describe("quota reset metadata", () => {
	it.each([
		["Claude text", (now: number) => parseClaudeUsageText("5h 99% · 7d 99% · Fable 99%", now)],
		[
			"Claude JSON",
			(now: number) =>
				parseClaudeUsageJson(
					JSON.stringify({
						five_hour_pct: 99,
						seven_day_pct: 99,
						raw: { limits: [{ kind: "weekly_scoped", percent: 99 }] },
					}),
					now,
					"UTC",
				),
		],
		[
			"Google AI",
			(now: number) => parseAgyQuota("Gemini Models\tFive Hour Limit Remaining\t1%\tN/A", now),
		],
		["Codex", (now: number) => parseCodexRateLimits({ primary: { used_percent: 99 } }, now, "UTC")],
	] as const)(
		"keeps %s percentages for display without alerting across midnight",
		async (_name, parse) => {
			const env = watcher();

			for (const now of [BEFORE_MIDNIGHT, AFTER_MIDNIGHT]) {
				const report = parse(now);

				expect(report.status).toBe("ok");
				expect(report.summary).toContain("99%");
				expect(report.limits.length).toBeGreaterThan(0);
				expect(report.limits.every((limit) => limit.windowId === undefined)).toBe(true);
			}

			expect((await env.check(parse(BEFORE_MIDNIGHT), BEFORE_MIDNIGHT)).crossed).toEqual([]);
			expect((await env.check(parse(AFTER_MIDNIGHT), AFTER_MIDNIGHT)).crossed).toEqual([]);
			expect(env.keys).toEqual([]);
			expect(env.getState().limits).toEqual({});
		},
	);

	it("alerts once for each actual five-hour reset within the same day", async () => {
		const env = watcher();
		const now = Date.parse("2026-11-19T01:00:00Z");
		const snapshot = (reset: string) =>
			parseClaudeUsageJson(
				JSON.stringify({ five_hour_pct: 99, five_hour_resets_at_iso: reset }),
				now,
				"UTC",
			);
		const first = snapshot("2026-11-19T06:00:00Z");
		const second = snapshot("2026-11-19T11:00:00Z");

		await env.check(first, now);
		await env.check(first, now);
		await env.check(parseClaudeUsageText("5h 99%", now), now);
		await env.check(first, now);
		await env.check(second, now + 5 * 60 * 60_000);
		await env.check(second, now + 5 * 60 * 60_000);

		expect(env.keys).toEqual([
			"quota:claude:5h:98:2026-11-19T06:00Z",
			"quota:claude:5h:98:2026-11-19T11:00Z",
		]);
	});
});
