import { crc32, inflateSync } from "node:zlib";

import type { Bitmap } from "$lib/doc";
import { describe, expect, it } from "vitest";

import { encodePng } from "./png.ts";

/** Decodes the subset encodePng writes: 1-bit grayscale, filter 0, one IDAT. */
function decode(png: Uint8Array): { width: number; height: number; black: boolean[][] } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

	expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	let offset = 8;
	let width = 0;
	let height = 0;
	let idat = new Uint8Array();
	const types: string[] = [];

	while (offset < png.length) {
		const length = view.getUint32(offset);
		const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
		const body = png.subarray(offset + 8, offset + 8 + length);

		expect(view.getUint32(offset + 8 + length), `${type} CRC`).toBe(
			crc32(png.subarray(offset + 4, offset + 8 + length)),
		);

		types.push(type);

		if (type === "IHDR") {
			width = new DataView(body.buffer, body.byteOffset).getUint32(0);
			height = new DataView(body.buffer, body.byteOffset).getUint32(4);
			expect([...body.subarray(8)]).toEqual([1, 0, 0, 0, 0]);
		}

		if (type === "IDAT") {
			idat = inflateSync(body);
		}

		offset += 12 + length;
	}

	expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
	const stride = Math.ceil(width / 8);
	const black = Array.from({ length: height }, (_, y) => {
		expect(idat[y * (stride + 1)]).toBe(0);

		return Array.from(
			{ length: width },
			(_unused, x) => (idat[y * (stride + 1) + 1 + (x >> 3)] & (0x80 >> (x & 7))) === 0,
		);
	});

	return { width, height, black };
}

describe("encodePng", () => {
	it("round-trips ink as black pixels at odd widths", () => {
		const width = 13;
		const height = 5;
		const data = new Uint8Array(width * height);
		const inked = new Set([0, 7, 8, 12, 2 * width + 3, 4 * width + 12]);

		for (const index of inked) {
			data[index] = 255;
		}

		data[width + 1] = 127;
		data[3 * width + 5] = 128;
		inked.add(3 * width + 5);
		const bitmap: Bitmap = { width, height, data };

		const decoded = decode(encodePng(bitmap));

		expect(decoded.width).toBe(width);
		expect(decoded.height).toBe(height);

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				expect(decoded.black[y][x], `pixel ${String(x)},${String(y)}`).toBe(
					inked.has(y * width + x),
				);
			}
		}
	});
});
