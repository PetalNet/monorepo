import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DAY_SCALE, windowGeometry } from "./dial.js";
import { limitsFrom, readLimit, type LimitWindow, type ProviderLimits } from "./limits.js";
import { quotaReadouts, usageReadoutFrom } from "./server/dossier.js";

const at = (iso: string) => Date.parse(iso);
const seconds = (iso: string) => at(iso) / 1000;

// Real feed figures from 2026-10-29, when Claude still had a 5-hour window. Claude's figures are
// claude.ai's `utilization`; Codex's copy `rate_limits.*.used_percent`. Both are percent used.
const claudeFeed = {
	scraped_at: seconds("2026-10-29T15:16:01Z"),
	raw: {
		five_hour: { utilization: 3, resets_at: "2026-10-29T20:10:00Z" },
		seven_day: { utilization: 50, resets_at: "2026-11-03T10:00:00.390029+00:00" },
	},
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
const windows = [
	usageReadoutFrom({
		label: "Claude",
		kind: "claude",
		data: claudeFeed,
		nowSeconds: now / 1000,
	}),
	usageReadoutFrom({
		label: "Codex",
		kind: "codex",
		data: codexFeed,
		nowSeconds: now / 1000,
	}),
].flatMap((provider) => limitsFrom(provider).windows);
const byId = (id: string) => {
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

	it("reads Codex at 100% with credits as drawing on credits, not stopped", () => {
		// The live snapshot: 100% of the 7-day window, 38,426 credits, rate_limit_reached_type null.
		const reading = readLimit(byId("codex-7d"), now);

		expect(reading).toMatchObject({ usedPct: 100, leftPct: 0, state: "on-credits" });
	});

	it("keeps the alarm for a limit the provider says has stopped requests", () => {
		const reading = readLimit({ ...byId("codex-7d"), blockedBy: "primary" }, now);

		expect(reading.state).toBe("limit-reached");
	});

	it("keeps the alarm once the credits are spent", () => {
		expect(readLimit({ ...byId("codex-7d"), credits: 0 }, now).state).toBe("limit-reached");
		expect(readLimit({ ...byId("codex-7d"), credits: null }, now).state).toBe("limit-reached");
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
				provider: "Claude",
				name: "5-hour",
				span: "5-hour",
				inactive: false,
				usedPct: 20,
				resetsAt: at("2026-10-29T18:00:00Z"),
				observedAt: at("2026-10-29T15:30:00Z"),
				credits: null,
				hasCredits: null,
				blockedBy: null,
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
			provider: "Codex",
			name: "7-day",
			span: "7-day",
			inactive: false,
			usedPct: 50,
			resetsAt: at("2026-11-05T00:00:00Z"),
			observedAt: at("2026-10-31T00:00:00Z"),
			credits: null,
			hasCredits: null,
			blockedBy: null,
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

describe("red span when the clocks go back", () => {
	let zone: string | undefined;

	beforeAll(() => {
		zone = process.env.TZ;
		process.env.TZ = "America/New_York";
	});

	afterAll(() => {
		process.env.TZ = zone;
	});

	// 01:30 EDT, in the repeated hour; the 5-hour window resets at 01:15 EST, 45 real minutes later.
	const spentAt = at("2026-11-01T05:30:00Z");
	const resetsAt = at("2026-11-01T06:15:00Z");
	const spent: LimitWindow = {
		id: "claude-5h",
		provider: "Claude",
		name: "5-hour",
		span: "5-hour",
		inactive: false,
		usedPct: 100,
		resetsAt,
		observedAt: spentAt,
		credits: null,
		hasCredits: null,
		blockedBy: null,
	};

	it("stays inside the window instead of wrapping into a near-full turn", () => {
		const reading = readLimit(spent, spentAt);
		const geometry = windowGeometry(reading, DAY_SCALE);

		expect(reading.state).toBe("limit-reached");
		expect(geometry?.groove).toBe(60);
		// 45 real minutes are at most 11.25 degrees of the day dial, and the span ends at the reset.
		expect(geometry?.lockout?.sweep).toBeGreaterThanOrEqual(0);
		expect(geometry?.lockout?.sweep).toBeLessThanOrEqual(11.25);
		expect((geometry?.lockout?.from ?? 0) + (geometry?.lockout?.sweep ?? 0)).toBe(geometry?.reset);
	});

	it("still spans now to the reset on an ordinary day", () => {
		const geometry = windowGeometry(
			readLimit({ ...spent, resetsAt: at("2026-11-02T06:15:00Z") }, at("2026-11-02T05:30:00Z")),
			DAY_SCALE,
		);

		expect(geometry?.lockout?.sweep).toBeCloseTo(11.25, 6);
	});
});

describe("limits from the feeds", () => {
	// Real feeds from 2026-11-17, trimmed to the fields read. Claude has no 5-hour window
	// (`five_hour: null`, while the top-level five_hour_pct still says 0) and a per-model Fable
	// weekly limit. Codex reports a 5-hour window beside its weekly one.
	const claudeToday = {
		five_hour_pct: 0,
		five_hour_resets_at: 0,
		seven_day_pct: 8,
		scraped_at: 1_794_939_242,
		raw: {
			five_hour: null,
			seven_day: { utilization: 8, resets_at: "2026-11-24T10:00:00.381339+00:00" },
			seven_day_opus: null,
			limits: [
				{
					kind: "weekly_all",
					percent: 8,
					resets_at: "2026-11-24T10:00:00.381339+00:00",
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_scoped",
					percent: 0,
					resets_at: "2026-11-24T10:00:00+00:00",
					scope: { model: { id: null, display_name: "Fable" }, surface: null },
					is_active: false,
				},
			],
		},
	};
	const codexToday = {
		five_hour_pct: 0,
		five_hour_resets_at: 1_794_947_325,
		seven_day_pct: 100,
		seven_day_resets_at: 1_795_016_116,
		plan: "plus",
		scraped_at: 1_794_939_303,
		snapshot_age_sec: 0,
		awaiting: false,
		credits_balance: 35_694.46,
		has_credits: true,
		rate_limit_reached_type: "rate_limit_reached",
	};
	const claude = (data: Record<string, unknown> = claudeToday) =>
		limitsFrom(
			usageReadoutFrom({
				label: "Claude",
				kind: "claude",
				data,
				nowSeconds: 1_794_939_400,
			}),
		);
	const codex = (data: Record<string, unknown> = codexToday) =>
		limitsFrom(
			usageReadoutFrom({
				label: "Codex",
				kind: "codex",
				data,
				nowSeconds: 1_794_939_400,
			}),
		);
	const summary = (limits: ProviderLimits) =>
		limits.windows.map(({ id, usedPct }) => ({ id, usedPct }));
	const windowOf = (limits: ProviderLimits, id: string) => {
		const window = limits.windows.find((candidate) => candidate.id === id);

		if (window === undefined) {
			throw new Error(`missing ${id}`);
		}

		return window;
	};

	it("draws exactly the windows each feed reports, with nothing to note", () => {
		expect(summary(claude())).toEqual([
			{ id: "claude-7d", usedPct: 8 },
			{ id: "claude-7d-fable", usedPct: 0 },
		]);

		expect(summary(codex())).toEqual([
			{ id: "codex-5h", usedPct: 0 },
			{ id: "codex-7d", usedPct: 100 },
		]);

		expect(claude().notes).toEqual([]);
		expect(codex().notes).toEqual([]);
	});

	it("draws a 5-hour window as soon as Claude reports one", () => {
		const withFiveHour = {
			...claudeToday,
			raw: {
				...claudeToday.raw,
				five_hour: { utilization: 12, resets_at: "2026-11-17T20:00:00Z" },
			},
		};

		expect(summary(claude(withFiveHour))).toEqual([
			{ id: "claude-5h", usedPct: 12 },
			{ id: "claude-7d", usedPct: 8 },
			{ id: "claude-7d-fable", usedPct: 0 },
		]);
	});

	it("draws no 5-hour window when Codex's feed has none", () => {
		const weeklyOnly = {
			seven_day_pct: 100,
			seven_day_resets_at: 1_795_016_116,
			scraped_at: 1_794_939_303,
		};

		expect(summary(codex(weeklyOnly))).toEqual([{ id: "codex-7d", usedPct: 100 }]);
	});

	it("reads a full Codex week carried by credits as using credits, despite rate_limit_reached", () => {
		// The live account: weekly at 100%, rateLimitReachedType "rate_limit_reached",
		// ordinaryUsageAllowed false, credits.hasCredits true, and work still running on credits.
		const week = windowOf(codex(), "codex-7d");
		const reading = readLimit(week, at("2026-11-17T18:20:00Z"));

		expect(reading).toMatchObject({ state: "on-credits", usedPct: 100 });
		expect(reading.window.credits).toBeCloseTo(35_694.46, 2);

		expect(readLimit({ ...week, hasCredits: false }, at("2026-11-17T18:20:00Z")).state).toBe(
			"limit-reached",
		);
	});

	it("reads Fable's own reset and the inactive flag", () => {
		expect(windowOf(claude(), "claude-7d-fable")).toMatchObject({
			resetsAt: at("2026-11-24T10:00:00Z"),
			inactive: true,
		});
	});

	const fable = (percent: number, extra: Record<string, unknown> = {}) => ({
		kind: "weekly_scoped",
		percent,
		resets_at: "2026-11-24T10:00:00+00:00",
		scope: { model: { id: null, display_name: "Fable" }, surface: null },
		is_active: true,
		...extra,
	});
	const withLimits = (limits: unknown[], raw: Record<string, unknown> = {}) => ({
		...claudeToday,
		raw: { ...claudeToday.raw, limits, ...raw },
	});

	it("keeps one window per identity, the fullest, and says there were more", () => {
		const result = claude(
			withLimits([fable(3), fable(90, { scope: { model: { display_name: "fable" } } })]),
		);
		const ids = result.windows.map(({ id }) => id);

		expect(new Set(ids).size).toBe(ids.length);
		expect(windowOf(result, "claude-7d-fable").usedPct).toBe(90);
		expect(result.notes).toEqual(["Reports more than one Fable 7-day limit; showing the fullest"]);
	});

	it("reads a per-model limit with no model name as unread, once", () => {
		const unnamed = { kind: "weekly_scoped", percent: 1, scope: { model: { display_name: " " } } };
		const result = claude(withLimits([unnamed, unnamed]));

		expect(result.windows.map(({ id }) => id)).toEqual(["claude-7d"]);
		expect(result.notes).toEqual(["Reports a weekly_scoped limit Astrolabe does not read"]);
	});

	it("falls back to weekly_all when seven_day is missing", () => {
		const weeklyAll = { kind: "weekly_all", percent: 8, resets_at: "2026-11-24T10:00:00Z" };
		const result = claude(withLimits([weeklyAll], { seven_day: null }));

		expect(summary(result)).toEqual([{ id: "claude-7d", usedPct: 8 }]);
	});

	it("names a per-model window Anthropic reports outside limits", () => {
		const result = claude(withLimits([], { seven_day_opus: { utilization: 70 } }));

		expect(result.notes).toEqual(["Reports a seven_day_opus limit Astrolabe does not read"]);
	});

	it("does not call a raw per-model window unread when limits gave the same model", () => {
		const opus = { ...fable(70), scope: { model: { display_name: "Opus" } } };
		const result = claude(withLimits([opus], { seven_day_opus: { utilization: 70 } }));

		expect(result.notes).toEqual([]);
		expect(result.windows.map(({ id }) => id)).toContain("claude-7d-opus");
	});
});

describe("quota feed limits", () => {
	const generatedAt = at("2026-11-19T22:44:00Z");
	const [tmobile, vpn] = quotaReadouts(
		{
			generatedAt,
			services: [
				{
					service: "tmobile",
					label: "T-Mobile",
					status: "ok",
					limits: [
						{
							id: "tmobile:cycle",
							label: "Cycle data",
							usedPct: 43.6,
							resetAtMs: at("2026-12-13T08:00:00Z"),
							windowMinutes: null,
						},
						{
							id: "tmobile:priority-week",
							label: "Priority week",
							usedPct: 149.3,
							resetAtMs: at("2026-11-23T08:00:00Z"),
							windowMinutes: null,
						},
						{
							id: "tmobile:hotspot",
							label: "Hotspot",
							usedPct: 149.3,
							resetAtMs: at("2026-11-19T23:44:00Z"),
							windowMinutes: 300,
						},
					],
				},
				{ service: "vpn", label: null, status: "signed-out", limits: [] },
			],
		},
		generatedAt + 60_000,
	).map((readout) => limitsFrom(readout));
	const readings = tmobile.windows.map((window) => readLimit(window, generatedAt + 60_000));

	it("reads a limit that is no dial window without a pace, keeping the feed's tenths", () => {
		expect(readings[0]).toMatchObject({
			window: { id: "tmobile-tmobile:cycle", provider: "T-Mobile", name: "Cycle data", span: null },
			state: "unpaced",
			usedPct: 43.6,
			resetsAt: at("2026-12-13T08:00:00Z"),
			projectedPct: null,
			lockoutAt: null,
		});

		expect(readings[0].leftPct).toBeCloseTo(56.4, 6);
	});

	it("shows usage past the limit as it is, with nothing left", () => {
		expect(readings[1]).toMatchObject({ state: "limit-reached", usedPct: 149.3, leftPct: 0 });
	});

	it("drops a figure once its limit has reset", () => {
		expect(readLimit(tmobile.windows[0], at("2026-12-13T08:00:00Z")).state).toBe(
			"reset-since-reading",
		);
	});

	it("fills a ring no further than its reset for usage past the limit", () => {
		// The window began at 18:44 and is 4h 1m old: an hour short of the reset.
		const geometry = windowGeometry(readings[2], DAY_SCALE);

		expect(readings[2]).toMatchObject({ state: "limit-reached", usedPct: 149.3 });
		expect(geometry?.fill).toBe(geometry?.reset);
		expect(geometry?.fill).toBeCloseTo(75, 5);
	});

	it("notes a service the feed could not read", () => {
		expect(vpn).toEqual({ windows: [], notes: ["Signed out"] });
	});
});
