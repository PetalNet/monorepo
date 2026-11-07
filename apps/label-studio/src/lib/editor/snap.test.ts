import { describe, expect, it } from "vitest";

import { resizeBox, snapBox, snapResize, snapTargets } from "./snap";

const frame = { w: 400, h: 70 };

describe("snapBox", () => {
	const targets = snapTargets(
		frame,
		{ start: 14, end: null },
		[{ x: 200, y: 10, w: 50, h: 20 }],
		"x",
	);

	it("pulls a near edge onto the start margin", () => {
		const { box, guides } = snapBox({ x: 17, y: 30, w: 40, h: 10 }, targets, 4);

		expect(box.x).toBe(14);
		expect(guides).toContainEqual({ axis: "x", at: 14 });
	});

	it("centres on the band middle", () => {
		const { box } = snapBox({ x: 100, y: 23, w: 40, h: 20 }, targets, 4);

		expect(box.y + box.h / 2).toBe(35);
	});

	it("snaps to another element's right edge", () => {
		const { box } = snapBox({ x: 252, y: 40, w: 30, h: 10 }, targets, 4);

		expect(box.x).toBe(250);
	});

	it("leaves a far box alone", () => {
		const start = { x: 120, y: 3 + 20, w: 7, h: 6 };
		const { box, guides } = snapBox(
			start,
			snapTargets(frame, { start: 14, end: null }, [], "x"),
			2,
		);

		expect(box).toEqual(start);
		expect(guides).toEqual([]);
	});
});

describe("resize", () => {
	it("grows from the east handle", () => {
		expect(resizeBox({ x: 10, y: 10, w: 20, h: 20 }, "e", 15, 0, false)).toEqual({
			x: 10,
			y: 10,
			w: 35,
			h: 20,
		});
	});

	it("keeps the far edge fixed from the north-west handle", () => {
		expect(resizeBox({ x: 10, y: 10, w: 20, h: 20 }, "nw", 5, 5, false)).toEqual({
			x: 15,
			y: 15,
			w: 15,
			h: 15,
		});
	});

	it("holds the aspect ratio when asked", () => {
		const box = resizeBox({ x: 0, y: 0, w: 40, h: 20 }, "se", 20, 2, true);

		expect(box.w / box.h).toBe(2);
	});

	it("never collapses below the minimum", () => {
		expect(resizeBox({ x: 0, y: 0, w: 10, h: 10 }, "e", -50, 0, false).w).toBe(2);
	});

	it("snaps only the moving edge", () => {
		const targets = snapTargets(frame, { start: 14, end: null }, [], "x");
		const { box } = snapResize({ x: 50, y: 5, w: 148, h: 20 }, "e", targets, 4);

		expect(box).toEqual({ x: 50, y: 5, w: 150, h: 20 });
	});
});
