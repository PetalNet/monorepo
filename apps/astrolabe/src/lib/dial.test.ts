import { beforeAll, describe, expect, it } from "vitest";

import { DAY_SCALE, WEEK_SCALE, type DialScale, windowGeometry } from "./dial.js";

const at = (iso: string) => Date.parse(iso);
const HOUR = 60 * 60 * 1000;
const turn = (degrees: number) => ((degrees % 360) + 360) % 360;

beforeAll(() => {
	process.env.TZ = "America/Chicago";
});

/** Places a window on a dial and returns the dial points as absolute angles. */
const place = (startsAt: number, resetsAt: number, now: number, scale: DialScale, usedPct = 40) => {
	const geometry = windowGeometry(
		{ startsAt, resetsAt, usedPct, projectedPct: null, runsOutAt: null },
		now,
		scale,
	);
	if (geometry === null) throw new Error("window did not place");

	return {
		tip: turn(geometry.start + geometry.elapsed),
		hand: turn(scale.angle(now)),
		reset: turn(geometry.start + geometry.reset),
		resetHand: turn(scale.angle(resetsAt)),
		fill: turn(geometry.start + geometry.fill),
		fillInstant: turn(scale.angle(startsAt + (usedPct / 100) * (resetsAt - startsAt))),
	};
};

describe("day dial across DST", () => {
	it("keeps the elapsed tip on the hand through the November fall-back", () => {
		// Pullfrog's repro: 00:00 CDT to 04:00 CST is five real hours but four clock hours.
		const dial = place(
			at("2026-11-01T05:00:00Z"),
			at("2026-11-01T10:00:00Z"),
			at("2026-11-01T07:30:00Z"),
			DAY_SCALE,
		);

		expect(dial.hand).toBeCloseTo(202.5, 5); // 01:30 CST
		expect(dial.tip).toBeCloseTo(dial.hand, 5);
		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});

	it("keeps the elapsed tip on the hand through the March spring-forward", () => {
		// 00:00 CST to 06:00 CDT is five real hours but six clock hours.
		const dial = place(
			at("2026-03-08T06:00:00Z"),
			at("2026-03-08T11:00:00Z"),
			at("2026-03-08T08:30:00Z"),
			DAY_SCALE,
		);

		expect(dial.hand).toBeCloseTo(232.5, 5); // 03:30 CDT
		expect(dial.tip).toBeCloseTo(dial.hand, 5);
		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});
});

describe("week dial across DST", () => {
	it("starts a window that spans the fall-back an hour off its reset angle", () => {
		const resetsAt = at("2026-11-05T10:00:00Z");
		const dial = place(resetsAt - 168 * HOUR, resetsAt, at("2026-11-02T12:00:00Z"), WEEK_SCALE);

		expect(dial.tip).toBeCloseTo(dial.hand, 5);
		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});

	it("starts a window that spans the spring-forward an hour off its reset angle", () => {
		const resetsAt = at("2026-03-12T10:00:00Z");
		const dial = place(resetsAt - 168 * HOUR, resetsAt, at("2026-03-10T12:00:00Z"), WEEK_SCALE);

		expect(dial.tip).toBeCloseTo(dial.hand, 5);
		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});
});

describe("window geometry without DST", () => {
	it("puts the tip on the hand and a 7-day window round one full turn", () => {
		const resetsAt = at("2026-10-29T15:00:00Z");
		const geometry = windowGeometry(
			{
				startsAt: resetsAt - 168 * HOUR,
				resetsAt,
				usedPct: 51,
				projectedPct: 160,
				runsOutAt: null,
			},
			at("2026-10-27T09:00:00Z"),
			WEEK_SCALE,
		);

		expect(geometry?.reset).toBeCloseTo(360, 5);
		expect(geometry?.projection).toBeCloseTo(360, 5); // An overshoot is capped at the reset.
		expect(turn((geometry?.start ?? 0) + (geometry?.elapsed ?? 0))).toBeCloseTo(
			WEEK_SCALE.angle(at("2026-10-27T09:00:00Z")),
			5,
		);
	});

	it("places nothing for a window without a reset", () => {
		expect(
			windowGeometry(
				{ startsAt: null, resetsAt: null, usedPct: 3, projectedPct: null, runsOutAt: null },
				0,
				DAY_SCALE,
			),
		).toBeNull();
	});
});
