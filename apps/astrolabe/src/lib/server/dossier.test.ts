import { describe, expect, it } from "vitest";

import {
	moonAgeDays,
	moonPhaseName,
	parseBackupLog,
	solarPhaseName,
	usageReadoutFrom,
} from "./dossier.js";

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
			slug: "janet-primary",
			label: "Claude",
			kind: "claude",
			data: null,
			nowSeconds: 1000,
		});
		expect(result).toMatchObject({ awaiting: false, stale: true, fiveHourPct: null });
	});

	it("marks a missing Codex feed awaiting", () => {
		const result = usageReadoutFrom({
			slug: "codex",
			label: "Codex",
			kind: "codex",
			data: null,
			nowSeconds: 1000,
		});
		expect(result).toMatchObject({ awaiting: true, stale: false, fiveHourPct: null });
	});

	it("uses the Claude ISO reset while Codex stays epoch-based", () => {
		const claude = usageReadoutFrom({
			slug: "janet-primary",
			label: "Claude",
			kind: "claude",
			nowSeconds: 1000,
			data: {
				five_hour_pct: null,
				seven_day_pct: 40,
				seven_day_resets_at_iso: "1970-01-01T00:20:00Z",
				scraped_at: 995,
			},
		});
		const codex = usageReadoutFrom({
			slug: "codex",
			label: "Codex",
			kind: "codex",
			nowSeconds: 1000,
			data: {
				five_hour_pct: null,
				seven_day_pct: 40,
				seven_day_resets_at: 1200,
				credits_balance: 3000,
				scraped_at: 995,
			},
		});
		expect(claude.sevenDayResetsAt).toBe(1200);
		expect(codex).toMatchObject({
			fiveHourPct: null,
			creditsBalance: 3000,
			stale: false,
			awaiting: false,
		});
	});
});
