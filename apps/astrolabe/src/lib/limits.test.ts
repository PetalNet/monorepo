import { describe, expect, it } from "vitest";

import { DAY_SCALE, windowGeometry } from "./dial.js";
import { limitWindowsFrom, readLimit, type LimitWindow } from "./limits.js";
import { usageReadoutFrom } from "./server/dossier.js";

const at = (iso: string) => Date.parse(iso);
const seconds = (iso: string) => at(iso) / 1000;

// Real feed shapes from 2026-10-29. Claude's *_pct fields copy claude.ai's `utilization`; Codex's copy
// `rate_limits.*.used_percent`. Both are percent of the limit used.
const claudeFeed = {
	five_hour_pct: 3,
	five_hour_resets_at: seconds("2026-10-29T20:10:00Z"),
	seven_day_pct: 50,
	seven_day_resets_at_iso: "2026-11-03T10:00:00.390029+00:00",
	scraped_at: seconds("2026-10-29T15:16:01Z"),
};
const codexFeed = {
	five_hour_pct: null,
	seven_day_pct: 100,
	seven_day_resets_at: seconds("2026-11-03T22:35:55Z"),
	scraped_at: seconds("2026-10-29T15:15:02Z"),
	snapshot_age_sec: 21_599,
	credits_balance: 38_426.39,
};
const now = at("2026-10-29T15:16:30Z");
const windows = limitWindowsFrom([
	usageReadoutFrom({
		slug: "janet-primary",
		label: "Claude",
		kind: "claude",
		data: claudeFeed,
		nowSeconds: now / 1000,
	}),
	usageReadoutFrom({
		slug: "codex",
		label: "Codex",
		kind: "codex",
		data: codexFeed,
		nowSeconds: now / 1000,
	}),
]);
const byId = (id: LimitWindow["id"]) => {
	const window = windows.find((candidate) => candidate.id === id);

	if (window === undefined) {
		throw new Error(`missing ${id}`);
	}

	return window;
};

describe("used versus left", () => {
	it("reads the feed figure as used, so 3% leaves 97%", () => {
		const reading = readLimit(byId("claude-5h"), now);

		expect(reading).toMatchObject({ usedPct: 3, leftPct: 97 });
	});

	it("reads Codex's 100% as an exhausted limit, not a full one", () => {
		const reading = readLimit(byId("codex-7d"), now);

		expect(reading).toMatchObject({ usedPct: 100, leftPct: 0, state: "limit-reached" });
	});

	it("grows the fill with usage", () => {
		const reading = readLimit(byId("claude-5h"), now);
		const fillAt = (usedPct: number) => windowGeometry({ ...reading, usedPct }, DAY_SCALE)?.fill;

		expect(fillAt(0)).toBe(0);
		expect(fillAt(3)).toBeLessThan(fillAt(50) ?? 0);
		expect(fillAt(100)).toBeCloseTo(75, 5); // 5 hours of a 24-hour dial.
	});
});

describe("burn-rate projection", () => {
	it("flags Claude's 7-day window: half used with under a third of the week gone", () => {
		const reading = readLimit(byId("claude-7d"), now);

		expect(reading.state).toBe("overshoot");
		expect(reading.projectedPct).toBeCloseTo(157.7, 1);
		// The week began Oct 27 10:00. 50% used over 2d 5h 16m reaches 100% at 4d 10h 32m: Oct 31 20:32, 2d 13h early.
		expect(Math.abs((reading.runsOutAt ?? 0) - at("2026-10-31T20:32:02Z"))).toBeLessThan(1000);
		expect(reading.runsOutAt).toBeLessThan(at("2026-11-03T10:00:00Z"));
	});

	it("calls a window on pace when the rate lands under the limit", () => {
		const reading = readLimit(
			{
				id: "claude-5h",
				agent: "Claude",
				span: "5-hour",
				usedPct: 20,
				resetsAt: at("2026-10-29T18:00:00Z"),
				observedAt: at("2026-10-29T15:30:00Z"),
			},
			at("2026-10-29T15:30:00Z"),
		);

		expect(reading).toMatchObject({ state: "on-pace", projectedPct: 40, runsOutAt: null });
		expect(reading.elapsed).toBeCloseTo(0.5, 5);
	});

	it("does not project from the first few minutes of a window", () => {
		expect(readLimit(byId("claude-5h"), now).state).toBe("too-early");
	});

	it("measures the rate up to when the figure was observed, not up to now", () => {
		const window: LimitWindow = {
			id: "codex-7d",
			agent: "Codex",
			span: "7-day",
			usedPct: 50,
			resetsAt: at("2026-11-05T00:00:00Z"),
			observedAt: at("2026-10-31T00:00:00Z"),
		};

		// 50% over the first 2 days observed: 175% at reset. Dividing by the 3 days to now would say 116.7%.
		expect(readLimit(window, at("2026-11-01T00:00:00Z")).projectedPct).toBeCloseTo(175, 5);
	});

	it("drops a figure whose window has since reset", () => {
		expect(readLimit(byId("claude-5h"), at("2026-10-29T20:11:00Z")).state).toBe(
			"reset-since-reading",
		);
	});
});
