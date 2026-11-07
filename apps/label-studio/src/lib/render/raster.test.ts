import { describe, expect, it } from "vitest";

import { bitmap, fill, PathBuilder } from "./raster.ts";

const sliver = (x: number, y: number, w: number, h: number) =>
	new PathBuilder()
		.moveTo(x, y)
		.lineTo(x + w, y)
		.lineTo(x + w, y + h)
		.lineTo(x, y + h)
		.close().lines;

const inkedRows = (target: { width: number; height: number; data: Uint8Array }) =>
	Array.from(
		{ length: target.height },
		(_, row) =>
			target.data.subarray(row * target.width, (row + 1) * target.width).filter(Boolean).length,
	);

describe("fill", () => {
	it("drops a hairline between pixel centres without dropout control", () => {
		const target = bitmap(8, 6);

		fill(target, sliver(1, 2.6, 6, 0.3));

		expect(inkedRows(target)).toEqual([0, 0, 0, 0, 0, 0]);
	});

	it("keeps horizontal and vertical hairlines with dropout control", () => {
		const across = bitmap(8, 6);
		const down = bitmap(6, 8);

		fill(across, sliver(1, 2.6, 6, 0.3), true);
		fill(down, sliver(2.6, 1, 0.3, 6), true);

		expect(inkedRows(across)).toEqual([0, 0, 6, 0, 0, 0]);
		expect(inkedRows(down)).toEqual([0, 1, 1, 1, 1, 1, 1, 0]);
	});

	it("leaves shapes wider than a dot exactly as without dropout control", () => {
		const plain = bitmap(10, 10);
		const guarded = bitmap(10, 10);

		fill(plain, sliver(1.2, 1.7, 6.3, 4.4));
		fill(guarded, sliver(1.2, 1.7, 6.3, 4.4), true);

		expect(guarded.data).toEqual(plain.data);
	});
});
