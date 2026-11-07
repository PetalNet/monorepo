import { describe, expect, it } from "vitest";

import { fitSize, toBase64, toGray } from "./image";

describe("image import", () => {
	it("caps the longer side at 1024 and keeps the aspect", () => {
		expect(fitSize(4096, 2048)).toEqual({ w: 1024, h: 512 });
		expect(fitSize(300, 200)).toEqual({ w: 300, h: 200 });
	});

	it("composites transparency over white and weights green highest", () => {
		const rgba = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255]);
		const gray = toGray(rgba);

		expect([...gray]).toEqual([0, 255, 182, 18]);
	});

	it("base64-encodes bytes", () => {
		expect(toBase64(new Uint8Array([0, 255, 128]))).toBe("AP+A");
	});
});
