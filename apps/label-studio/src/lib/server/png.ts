import { crc32, deflateSync } from "node:zlib";

import type { Bitmap } from "$lib/doc";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/**
 * Encode a bitmap as a 1-bit grayscale PNG. Ink (data ≥ 128) becomes black, a 0 bit, because the
 * print daemon burns dark pixels.
 */
export function encodePng(bitmap: Bitmap): Uint8Array<ArrayBuffer> {
	const { width, height, data } = bitmap;
	const stride = Math.ceil(width / 8);
	const scanlines = new Uint8Array((stride + 1) * height);

	for (let y = 0; y < height; y++) {
		const row = y * (stride + 1);

		// Filter byte 0 (none), then white everywhere until ink clears a bit.
		scanlines.fill(0xff, row + 1, row + 1 + stride);

		for (let x = 0; x < width; x++) {
			if (data[y * width + x] >= 128) {
				scanlines[row + 1 + (x >> 3)] &= ~(0x80 >> (x & 7));
			}
		}
	}

	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);

	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([1, 0, 0, 0, 0], 8);

	return concat([
		SIGNATURE,
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(scanlines)),
		chunk("IEND", new Uint8Array()),
	]);
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + body.length);
	const view = new DataView(out.buffer);

	view.setUint32(0, body.length);
	const typed = new TextEncoder().encode(type);

	out.set(typed, 4);
	out.set(body, 8);
	view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));

	return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;

	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}

	return out;
}

export function pngDataUrl(png: Uint8Array): string {
	return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}
