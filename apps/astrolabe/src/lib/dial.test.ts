import { beforeAll, describe, expect, it } from "vitest";

import {
	ASCENDER_HEIGHT,
	BOSS_RADIUS,
	CAP_HEIGHT,
	DAY_SCALE,
	readingArc,
	RING_LABEL_SIZE,
	ringLabelBaseline,
	stackBaselines,
	WEEK_RINGS,
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
		now,
		scale,
	);

	if (geometry === null) {
		throw new Error("window did not place");
	}

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

describe("ring names", () => {
	const [outerRadius, innerRadius] = WEEK_RINGS.radii;
	const edges = (radius: number) => ({
		inner: radius - WEEK_RINGS.width / 2,
		outer: radius + WEEK_RINGS.width / 2,
	});
	const lettering = (ringInner: number) => {
		const baseline = ringLabelBaseline(ringInner);

		return { low: baseline, high: baseline + RING_LABEL_SIZE * CAP_HEIGHT };
	};

	const outer = edges(outerRadius);
	const inner = edges(innerRadius);
	const claude = lettering(outer.inner);
	const codex = lettering(inner.inner);

	it("letters both week rings at twelve o'clock without touching each other or a ring", () => {
		// Both names are centred on the same angle, so they are apart exactly when their radii are.
		expect(claude.high).toBeLessThan(outer.inner);
		expect(claude.low).toBeGreaterThan(inner.outer);
		expect(codex.high).toBeLessThan(inner.inner);
		expect(codex.low).toBeGreaterThan(BOSS_RADIUS + 0.6);
		expect(claude.low).toBeGreaterThan(codex.high);
	});

	it("keeps the outer name clear of the inner ring's elapsed line and its tip", () => {
		// LimitRing draws the elapsed line 3.2 units outside the band, and its tip reaches 2.4 further.
		expect(claude.low).toBeGreaterThan(inner.outer + 3.2 + 2.4);
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
