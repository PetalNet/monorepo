import { describe, expect, it } from "vitest";

import capture from "../fixtures/quota.json";
import {
	moonAgeDays,
	moonPhaseName,
	parseBackupLog,
	quotaReadouts,
	solarPhaseName,
	usageReadoutFrom,
} from "./dossier.js";
import { parseQuotaFeed } from "./quota.js";

describe("moon helpers", () => {
	it("names lunar phases and scales age across one synodic month", () => {
		expect(moonPhaseName(0)).toBe("New moon");
		expect(moonPhaseName(0.25)).toBe("First quarter");
		expect(moonPhaseName(0.5)).toBe("Full moon");
		expect(moonPhaseName(0.75)).toBe("Last quarter");
		expect(moonAgeDays(0.5)).toBeCloseTo(14.765, 2);
	});
});

describe("solar phase", () => {
	const times = {
		dawnAt: 100 * 60_000,
		sunriseAt: 200 * 60_000,
		solarNoonAt: 500 * 60_000,
		sunsetAt: 800 * 60_000,
		duskAt: 900 * 60_000,
	};

	it("uses named daylight periods", () => {
		expect(solarPhaseName(times, 50 * 60_000)).toBe("night");
		expect(solarPhaseName(times, 150 * 60_000)).toBe("dawn");
		expect(solarPhaseName(times, 300 * 60_000)).toBe("morning");
		expect(solarPhaseName(times, 500 * 60_000)).toBe("midday");
		expect(solarPhaseName(times, 700 * 60_000)).toBe("afternoon");
		expect(solarPhaseName(times, 850 * 60_000)).toBe("dusk");
	});
});

describe("backup parsing", () => {
	it("reverse-scans the last attempt and success", () => {
		const log =
			"[Wed Mar 12 04:03:27 UTC 2026] Starting offsite backup\n[Wed Mar 12 04:12:27 UTC 2026] Offsite backup complete\n[Thu Mar 13 04:03:27 UTC 2026] Starting offsite backup";
		const parsed = parseBackupLog(log);

		expect(parsed.lastSuccessAt).toBe(Date.parse("Wed Mar 12 04:12:27 UTC 2026"));
		expect(parsed.lastAttemptAt).toBe(Date.parse("Thu Mar 13 04:03:27 UTC 2026"));
	});
});

describe("usage readouts", () => {
	it("keeps a missing Claude feed stale but not awaiting", () => {
		const result = usageReadoutFrom({
			label: "Claude",
			kind: "claude",
			data: null,
			nowSeconds: 1000,
		});

		expect(result).toMatchObject({ awaiting: false, stale: true, windows: [] });
	});

	it("marks a missing Codex feed awaiting", () => {
		const result = usageReadoutFrom({
			label: "Codex",
			kind: "codex",
			data: null,
			nowSeconds: 1000,
		});

		expect(result).toMatchObject({ awaiting: true, stale: false, windows: [] });
	});

	it("reads a Codex feed whose only window is the 7-day one as 7-day, with no 5-hour window", () => {
		// codex-usage buckets by window length, so a lone weekly `primary` arrives as seven_day_pct.
		const codex = usageReadoutFrom({
			label: "Codex",
			kind: "codex",
			nowSeconds: 1000,
			data: {
				five_hour_pct: null,
				five_hour_resets_at: null,
				seven_day_pct: 100,
				seven_day_resets_at: 1200,
				credits_balance: 38_426.39,
				rate_limit_reached_type: null,
				scraped_at: 995,
			},
		});

		expect(codex.windows).toEqual([
			{ key: "7d", name: "7-day", span: "7-day", usedPct: 100, resetsAt: 1200, inactive: false },
		]);

		expect(codex).toMatchObject({ creditsBalance: 38_426.39, limitReachedType: null });
	});

	it("names the plan each feed reports, and spells out one it doesn't know", () => {
		const plan = (kind: "claude" | "codex", data: Record<string, unknown>) =>
			usageReadoutFrom({
				label: kind === "codex" ? "Codex" : "Claude",
				kind,
				nowSeconds: 1000,
				data: { scraped_at: 995, ...data },
			}).plan;

		expect(plan("codex", { plan: "prolite" })).toBe("Pro 100");
		expect(plan("codex", { plan: "pro" })).toBe("Pro 200");
		expect(plan("codex", { plan: "constructor" })).toBe("constructor");
		expect(plan("codex", {})).toBeNull();

		const ultra = { subscription_type: "max", rate_limit_tier: "default_claude_max_20x" };

		expect(plan("claude", ultra)).toBe("Ultra");
		expect(plan("claude", { ...ultra, rate_limit_tier: "default_claude_max_5x" })).toBe("Max");
		expect(plan("claude", { subscription_type: "max" })).toBe("Max");
		expect(plan("claude", { subscription_type: "pro", rate_limit_tier: "some_tier" })).toBe("Pro");
		// Codex's own field is not Claude's plan.
		expect(plan("claude", { plan: "prolite" })).toBeNull();
	});

	it("passes Codex's rate_limit_reached_type through, and ignores it for Claude", () => {
		const data = { seven_day_pct: 100, rate_limit_reached_type: "primary", scraped_at: 995 };
		const read = (kind: "claude" | "codex") =>
			usageReadoutFrom({
				label: kind === "codex" ? "Codex" : "Claude",
				kind,
				nowSeconds: 1000,
				data,
			}).limitReachedType;

		expect(read("codex")).toBe("primary");
		expect(read("claude")).toBeNull();
	});

	it("takes Claude's windows from the raw response, not the zeroed top-level 5-hour fields", () => {
		const claude = usageReadoutFrom({
			label: "Claude",
			kind: "claude",
			nowSeconds: 1000,
			data: {
				five_hour_pct: 0,
				five_hour_resets_at: 0,
				scraped_at: 995,
				raw: {
					five_hour: null,
					seven_day: { utilization: 40, resets_at: "1970-01-01T00:20:00Z" },
					limits: [
						{ kind: "weekly_all", percent: 40, resets_at: "1970-01-01T00:20:00Z" },
						{
							kind: "weekly_scoped",
							percent: 5,
							resets_at: "1970-01-01T00:20:00Z",
							scope: { model: { id: null, display_name: "Fable" } },
							is_active: false,
						},
						{ kind: "daily_burst", percent: 1 },
					],
				},
			},
		});

		expect(claude.windows).toEqual([
			{ key: "7d", name: "7-day", span: "7-day", usedPct: 40, resetsAt: 1200, inactive: false },
			{
				key: "7d-fable",
				name: "Fable 7-day",
				span: "7-day",
				usedPct: 5,
				resetsAt: 1200,
				inactive: true,
			},
		]);

		expect(claude.unreadKinds).toEqual(["daily_burst"]);
	});

	it("cannot say which windows a Claude snapshot without raw has", () => {
		const claude = usageReadoutFrom({
			label: "Claude",
			kind: "claude",
			nowSeconds: 1000,
			data: { seven_day_pct: 40, scraped_at: 995 },
		});

		expect(claude.windows).toEqual([]);
	});
});

describe("quota feed readouts", () => {
	const feed = parseQuotaFeed(capture);
	const minute = 60_000;

	it("reads each service as a provider, with its limits named as the feed names them", () => {
		const readouts = quotaReadouts(feed, feed.generatedAt + minute);
		const tmobile = readouts.find((readout) => readout.kind === "tmobile");

		expect(readouts.map((readout) => readout.kind)).toEqual([
			"claude",
			"google-ai",
			"codex",
			"cloudflare-ai",
			"github-actions",
			"tmobile",
		]);

		// The capture names no service, so each shows as its id.
		expect(tmobile).toMatchObject({
			label: "tmobile",
			plan: null,
			status: "ok",
			stale: false,
			observedAt: 1_795_121_040,
		});

		expect(tmobile?.windows).toEqual([
			{
				key: "tmobile:cycle",
				name: "T-Mobile cycle data",
				span: null,
				usedPct: 43.6,
				resetsAt: 1_797_141_600,
				inactive: false,
			},
			{
				key: "tmobile:priority-week",
				name: "T-Mobile priority week",
				span: null,
				usedPct: 149.3,
				resetsAt: 1_795_413_600,
				inactive: false,
			},
		]);
	});

	it("puts a limit on a dial only when the feed gives a 5-hour or 7-day window and its reset", () => {
		const spanOf = (limit: Record<string, unknown>) =>
			quotaReadouts(
				parseQuotaFeed({
					generatedAt: 1000,
					services: [
						{
							service: "google-ai",
							label: "Google AI",
							status: "ok",
							limits: [{ id: "google-ai:gemini", label: "Gemini", usedPct: 1, ...limit }],
						},
					],
				}),
				2000,
			)[0].windows[0].span;

		expect(spanOf({ windowMinutes: 300, resetAtMs: 9000 })).toBe("5-hour");
		expect(spanOf({ windowMinutes: 10_080, resetAtMs: 9000 })).toBe("7-day");
		expect(spanOf({ windowMinutes: 1440, resetAtMs: 9000 })).toBeNull();
		expect(spanOf({ windowMinutes: 300 })).toBeNull();
		// The id's suffix is not the window length.
		expect(spanOf({ id: "google-ai:gemini:5h", resetAtMs: 9000 })).toBeNull();
	});

	it("marks a feed stale after 15 minutes and refuses one dated in the future", () => {
		const staleAt = (now: number) => quotaReadouts(feed, now).map((readout) => readout.stale);

		expect(staleAt(feed.generatedAt + 15 * minute)).not.toContain(true);
		expect(staleAt(feed.generatedAt + 15 * minute + 1)).not.toContain(false);
		expect(() => quotaReadouts(feed, feed.generatedAt - 1)).toThrow();
	});
});
