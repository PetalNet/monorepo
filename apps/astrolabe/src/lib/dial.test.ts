import { beforeAll, describe, expect, it } from "vitest";

import {
	ASCENDER_HEIGHT,
	CAP_HEIGHT,
	DAY_SCALE,
	readingArc,
	usageLabelAt,
	stackBaselines,
	WEEK_SCALE,
	type DialScale,
	windowGeometry,
} from "./dial.js";

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
		scale,
	);

	if (geometry === null) {
		throw new Error("window did not place");
	}

	return {
		hand: turn(scale.angle(now)),
		reset: turn(geometry.start + geometry.reset),
		resetHand: turn(scale.angle(resetsAt)),
		fill: turn(geometry.start + geometry.fill),
		fillInstant: turn(scale.angle(startsAt + (usedPct / 100) * (resetsAt - startsAt))),
	};
};

describe("day dial across DST", () => {
	it("puts the reset and fill on their own clock angles through the November fall-back", () => {
		// Pullfrog's repro: 00:00 CDT to 04:00 CST is five real hours but four clock hours.
		const dial = place(
			at("2026-11-01T05:00:00Z"),
			at("2026-11-01T10:00:00Z"),
			at("2026-11-01T07:30:00Z"),
			DAY_SCALE,
		);

		expect(dial.hand).toBeCloseTo(202.5, 5); // 01:30 CST
		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});

	it("puts the reset and fill on their own clock angles through the March spring-forward", () => {
		// 00:00 CST to 06:00 CDT is five real hours but six clock hours.
		const dial = place(
			at("2026-03-08T06:00:00Z"),
			at("2026-03-08T11:00:00Z"),
			at("2026-03-08T08:30:00Z"),
			DAY_SCALE,
		);

		expect(dial.hand).toBeCloseTo(232.5, 5); // 03:30 CDT
		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});
});

describe("week dial across DST", () => {
	it("starts a window that spans the fall-back an hour off its reset angle", () => {
		const resetsAt = at("2026-11-05T10:00:00Z");
		const dial = place(resetsAt - 168 * HOUR, resetsAt, at("2026-11-02T12:00:00Z"), WEEK_SCALE);

		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});

	it("starts a window that spans the spring-forward an hour off its reset angle", () => {
		const resetsAt = at("2026-03-12T10:00:00Z");
		const dial = place(resetsAt - 168 * HOUR, resetsAt, at("2026-03-10T12:00:00Z"), WEEK_SCALE);

		expect(dial.reset).toBeCloseTo(dial.resetHand, 5);
		expect(dial.fill).toBeCloseTo(dial.fillInstant, 5);
	});
});

describe("window geometry without DST", () => {
	it("puts a 7-day window round one full turn and caps an overshoot at the reset", () => {
		const resetsAt = at("2026-10-29T15:00:00Z");
		const geometry = windowGeometry(
			{
				startsAt: resetsAt - 168 * HOUR,
				resetsAt,
				usedPct: 51,
				projectedPct: 160,
				runsOutAt: null,
			},
			WEEK_SCALE,
		);

		expect(geometry?.reset).toBeCloseTo(360, 5);
		expect(geometry?.projection).toBeCloseTo(360, 5);
	});

	it("places nothing for a window without a reset", () => {
		expect(
			windowGeometry(
				{ startsAt: null, resetsAt: null, usedPct: 3, projectedPct: null, runsOutAt: null },
				DAY_SCALE,
			),
		).toBeNull();
	});
});

describe("centre boss lettering", () => {
	// The dial is 240 units across and never drawn wider than about 420 px, so 0.5 units is under 1 px.
	const HALF_PIXEL = 0.25;

	it("centres a line and its caption on the dial centre", () => {
		const line = { size: 10.5, rise: ASCENDER_HEIGHT };
		const caption = { size: 7.4, rise: CAP_HEIGHT };
		const baselines = stackBaselines(line, caption, 4.6);
		const inkTop = baselines.line - line.size * line.rise;

		expect((inkTop + baselines.caption) / 2).toBeCloseTo(0, 6);
		expect(baselines.caption - baselines.line).toBeCloseTo(4.6 + caption.size * caption.rise, 6);
	});

	it("centres a lone line when a 24-hour locale has no day period", () => {
		const line = { size: 15, rise: CAP_HEIGHT };
		const { line: baseline } = stackBaselines(line, null, 4.6);

		expect(Math.abs(baseline - (line.size * line.rise) / 2)).toBeLessThan(HALF_PIXEL);
	});
});

describe("reading arcs", () => {
	const start = (path: string) => {
		const [, x, y] = path.split(" ");

		return { x: Number(x), y: Number(y) };
	};

	it("runs clockwise across the top so letters stand upright", () => {
		const path = readingArc(0, 60, 100);

		expect(path).toContain(" 0 0 1 ");
		expect(start(path).x).toBeLessThan(0);
		expect(start(path).y).toBeLessThan(0);
	});

	it("runs anticlockwise across the bottom so letters read left to right", () => {
		const path = readingArc(180, 60, 100);

		expect(path).toContain(" 0 0 0 ");
		expect(start(path).x).toBeLessThan(0);
		expect(start(path).y).toBeGreaterThan(0);
	});
});

describe("groove", () => {
	it("rings the whole week dial for a 7-day window across the fall-back", () => {
		// 168 real hours are 167 on the wall clock, so the window's own sweep stops 2.14° short of its
		// start and used to leave a wedge of bare paper beside the reset rule.
		const resetsAt = at("2026-11-03T10:00:00Z");
		const geometry = windowGeometry(
			{
				startsAt: resetsAt - 168 * HOUR,
				resetsAt,
				usedPct: 55,
				projectedPct: null,
				runsOutAt: null,
			},
			WEEK_SCALE,
		);

		expect(geometry?.reset).toBeCloseTo(357.86, 2);
		expect(geometry?.groove).toBe(360);
	});

	it("runs a 5-hour window's groove only from its start to its reset", () => {
		const resetsAt = at("2026-10-29T20:10:00Z");
		const geometry = windowGeometry(
			{ startsAt: resetsAt - 5 * HOUR, resetsAt, usedPct: 21, projectedPct: null, runsOutAt: null },
			DAY_SCALE,
		);

		expect(geometry?.groove).toBeCloseTo(75, 5);
		expect(geometry?.groove).toBeCloseTo(geometry?.reset ?? 0, 5);
	});
});

describe("usage figure", () => {
	const separation = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
	const ring = { start: 0, reset: 300, radius: 79, halfDeg: 6 };
	// Degrees the hand and the reset diamond keep clear of the figure's edge, from usageLabelAt.
	const handGap = (3 / 79) * (180 / Math.PI);
	const resetGap = (4 / 79) * (180 / Math.PI);

	it("sits just past the end of the fill when that spot is clear", () => {
		expect(usageLabelAt({ ...ring, fill: 100, hand: 200 })).toEqual({ angle: 106, inside: false });
	});

	it("moves inside the fill's end when the hand is just past it", () => {
		const spot = usageLabelAt({ ...ring, fill: 100, hand: 105 });

		expect(spot).toEqual({ angle: 94, inside: true });
		expect(separation(spot?.angle ?? 0, 105)).toBeGreaterThan(ring.halfDeg + handGap);
	});

	it("keeps clear of the reset diamond", () => {
		const spot = usageLabelAt({ ...ring, fill: 292, hand: 100 });

		expect(spot?.inside).toBe(true);
		expect(separation(spot?.angle ?? 0, 300)).toBeGreaterThan(ring.halfDeg + resetGap);
	});

	it("steps back inside a full ring, clear of the reset diamond", () => {
		const spot = usageLabelAt({ ...ring, fill: 300, hand: 100 });

		expect(spot?.inside).toBe(true);
		expect(separation(spot?.angle ?? 0, 300)).toBeGreaterThan(ring.halfDeg + resetGap);
	});

	it("gives up rather than sit on the hand or the reset", () => {
		expect(usageLabelAt({ ...ring, fill: 4, hand: 8 })).toBeNull();
	});
});
