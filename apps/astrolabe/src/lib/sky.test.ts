import * as SunCalc from "suncalc";
import { beforeAll, describe, expect, it } from "vitest";

import { nextSolarEvent, solarCountdown } from "./sky.js";

const DALLAS = { lat: 32.78, lon: -96.8 };
const DAY_MS = 24 * 60 * 60 * 1000;

const epoch = (date: Date | null): number => {
	if (date === null) {
		throw new Error("SunCalc returned no event for Dallas");
	}

	return date.getTime();
};

// Built the same way as the dossier: SunCalc's day for `now`, plus the next day's sunrise.
const solarTimesAt = (now: number) => {
	const today = SunCalc.getTimes(new Date(now), DALLAS.lat, DALLAS.lon);
	const tomorrow = SunCalc.getTimes(new Date(now + DAY_MS), DALLAS.lat, DALLAS.lon);

	return {
		sunriseAt: epoch(today.sunrise),
		sunsetAt: epoch(today.sunset),
		nextDaySunriseAt: epoch(tomorrow.sunrise),
	};
};

beforeAll(() => {
	// The browser runs in the reader's zone. A countdown built from local wall-clock minutes breaks here.
	process.env.TZ = "America/Chicago";
});

describe("next solar event", () => {
	it("uses tomorrow's sunrise for the verified evening instant", () => {
		const now = Date.parse("2026-10-26T01:00:00Z");
		const nextDaySunriseAt = Date.parse("2026-10-26T12:40:00Z");
		const result = nextSolarEvent(
			{
				sunriseAt: Date.parse("2026-10-25T12:39:00Z"),
				sunsetAt: Date.parse("2026-10-25T23:42:00Z"),
				nextDaySunriseAt,
			},
			now,
		);

		expect(result).toEqual({ kind: "sunrise", at: nextDaySunriseAt });
	});

	it("skips an event that passed between polls", () => {
		const times = solarTimesAt(Date.parse("2026-10-25T23:00:00Z"));

		expect(nextSolarEvent(times, times.sunsetAt + 60_000)).toEqual({
			kind: "sunrise",
			at: times.nextDaySunriseAt,
		});
	});
});

describe("solar countdown", () => {
	it("counts overnight to tomorrow's sunrise, not today's", () => {
		const now = Date.parse("2026-10-26T01:00:00Z");

		// 12:40:02.7Z on Oct 26. Today's 12:39:13.6Z sunrise would read 699.2.
		const countdown = solarCountdown(solarTimesAt(now), now);

		expect(countdown?.kind).toBe("sunrise");
		expect(countdown?.minutes).toBeCloseTo(700.05, 1);
	});

	it("keeps real minutes across the November fall-back", () => {
		// 1:30 AM CDT; clocks fall back at 2:00. Sunrise is 6:45 AM CST, 375 real minutes away, 315 by the wall clock.
		const now = Date.parse("2026-11-01T06:30:00Z");

		const countdown = solarCountdown(solarTimesAt(now), now);

		expect(countdown?.kind).toBe("sunrise");
		expect(countdown?.minutes).toBeCloseTo(375.08, 1);
	});

	it("keeps real minutes across the March spring-forward", () => {
		// 1:30 AM CST; clocks spring forward at 2:00. Sunrise is 7:46 AM CDT, 316 real minutes away, 376 by the wall clock.
		const now = Date.parse("2026-03-08T07:30:00Z");

		const countdown = solarCountdown(solarTimesAt(now), now);

		expect(countdown?.kind).toBe("sunrise");
		expect(countdown?.minutes).toBeCloseTo(316.27, 1);
	});

	it("reports nothing when the sun neither rises nor sets", () => {
		expect(
			solarCountdown({ sunriseAt: null, sunsetAt: null, nextDaySunriseAt: null }, 0),
		).toBeNull();
	});
});
