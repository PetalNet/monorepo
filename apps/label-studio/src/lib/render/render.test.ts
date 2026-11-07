import {
	mmToDots,
	tapeGeometry,
	type Bitmap,
	type CodeElement,
	type ImageElement,
	type LabelDoc,
	type LabelElement,
	type RenderResult,
	type ShapeElement,
	type TextElement,
} from "$lib/doc";
import { serverFonts } from "$lib/server/fonts";
import bwip from "bwip-js/generic";
import { describe, expect, it, vi } from "vitest";

import { QR } from "../templates/qr.ts";
import { renderLabel } from "./index.ts";
import { bitmap } from "./raster.ts";
import type * as Raster from "./raster.ts";

vi.mock("./raster.ts", async (importOriginal) => {
	const raster = await importOriginal<typeof Raster>();

	return { ...raster, bitmap: vi.fn(raster.bitmap) };
});

const tape = tapeGeometry(12);

const label = (elements: LabelElement[], extra: Partial<LabelDoc> = {}): LabelDoc => ({
	version: 1,
	tapeMm: 12,
	orientation: "horizontal",
	length: { mode: "fixed", mm: 30 },
	margin: { startMm: 2, endMm: 2 },
	invert: false,
	border: null,
	elements,
	...extra,
});

const base = { rotate: 0, invert: false } as const;

const rect = (
	id: string,
	x: number,
	y: number,
	w: number,
	h: number,
	extra: Partial<ShapeElement> = {},
): ShapeElement => ({
	...base,
	id,
	kind: "shape",
	shape: "rect",
	x,
	y,
	w,
	h,
	fill: true,
	stroke: 0,
	radius: 0,
	dashed: false,
	...extra,
});

const text = (id: string, value: string, extra: Partial<TextElement> = {}): TextElement => ({
	...base,
	id,
	kind: "text",
	x: 4,
	y: 4,
	w: 120,
	h: 40,
	text: value,
	font: "inter",
	size: 200,
	bold: false,
	italic: false,
	align: "center",
	valign: "middle",
	lineHeight: 1.2,
	tracking: 0,
	fit: "fill",
	widthMode: "fixed",
	...extra,
});

const code = (
	id: string,
	symbology: CodeElement["symbology"],
	data: string,
	extra: Partial<CodeElement> = {},
): CodeElement => ({
	...base,
	id,
	kind: "code",
	x: 0,
	y: 0,
	w: 200,
	h: 70,
	symbology,
	data,
	ecc: "M",
	showText: false,
	...extra,
});

const gray = (values: number[]): string => btoa(String.fromCodePoint(...values));

const image = (
	id: string,
	pixels: number[],
	srcW: number,
	srcH: number,
	extra: Partial<ImageElement> = {},
): ImageElement => ({
	...base,
	id,
	kind: "image",
	x: 0,
	y: 0,
	w: srcW,
	h: srcH,
	gray: gray(pixels),
	srcW,
	srcH,
	mode: "threshold",
	threshold: 128,
	fit: "stretch",
	...extra,
});

const inked = (target: Bitmap): [number, number][] => {
	const out: [number, number][] = [];

	for (let y = 0; y < target.height; y++) {
		for (let x = 0; x < target.width; x++) {
			if (target.data[y * target.width + x]) {
				out.push([x, y]);
			}
		}
	}

	return out;
};

const bounds = (target: Bitmap) => {
	const points = inked(target);
	const xs = points.map(([x]) => x);
	const ys = points.map(([, y]) => y);

	return {
		count: points.length,
		x0: Math.min(...xs),
		x1: Math.max(...xs),
		y0: Math.min(...ys),
		y1: Math.max(...ys),
	};
};

const rasterOf = (result: RenderResult): Bitmap => {
	if (!result.raster) {
		throw new Error("print mode should return a raster");
	}

	return result.raster;
};

const at = (target: Bitmap, x: number, y: number): number => target.data[y * target.width + x];

const print = (doc: LabelDoc) => renderLabel(doc, { tape }, serverFonts);

describe("geometry", () => {
	it("fills a rect on exactly its dots and places the band at the tape margin", async () => {
		const result = await print(label([rect("r", 10, 5, 20, 30)]));

		expect(bounds(result.frame)).toEqual({ count: 600, x0: 10, x1: 29, y0: 5, y1: 34 });
		expect(result.raster?.height).toBe(128);
		expect(bounds(rasterOf(result))).toEqual({ count: 600, x0: 10, x1: 29, y0: 34, y1: 63 });
		expect(result.frame.data.every((value) => value === 0 || value === 255)).toBe(true);
	});

	it("draws a 1-dot line as a single row of dots", async () => {
		const line = rect("l", 3, 10, 50, 5, { shape: "line-h", fill: false, stroke: 1 });
		const result = await print(label([line]));

		expect(bounds(result.frame)).toEqual({ count: 50, x0: 3, x1: 52, y0: 12, y1: 12 });
	});

	it("maps vertical frame (x, y) onto tape (y, pins - 1 - x)", async () => {
		const result = await print(label([rect("m", 3, 10, 1, 1)], { orientation: "vertical" }));

		expect(result.frame.width).toBe(tape.pins);

		expect(bounds(rasterOf(result))).toEqual({
			count: 1,
			x0: 10,
			x1: 10,
			y0: tape.margin + tape.pins - 4,
			y1: tape.margin + tape.pins - 4,
		});
	});

	it("turns content clockwise like CSS rotate()", async () => {
		const corner = image("c", [0, 255, 255, 255], 2, 2, { w: 10, h: 20, rotate: 90 });
		const result = await print(label([corner]));

		expect(bounds(result.frame)).toEqual({ count: 50, x0: 5, x1: 9, y0: 0, y1: 9 });
	});

	it("knocks an inverted element's content out of a box of ink", async () => {
		const outline = rect("o", 0, 0, 20, 20, { fill: false, stroke: 2, invert: true });
		const result = await print(label([outline]));

		expect(at(result.frame, 0, 0)).toBe(0);
		expect(at(result.frame, 10, 10)).toBe(255);
		expect(bounds(result.frame).count).toBe(20 * 20 - (20 * 20 - 16 * 16));
	});

	it("inverts the whole band and draws a border inset from the edge", async () => {
		const border = await print(label([], { border: { stroke: 2, radius: 0, inset: 1 } }));

		expect(at(border.frame, 1, 1)).toBe(255);
		expect(at(border.frame, 0, 0)).toBe(0);
		expect(at(border.frame, 3, 3)).toBe(0);

		const inverted = await print(label([], { invert: true }));

		expect(inverted.frame.data.every((value) => value === 255)).toBe(true);
	});

	it("sizes an auto-length label to the furthest element plus the end margin", async () => {
		const result = await print(label([rect("r", 40, 0, 25, 10)], { length: { mode: "auto" } }));

		expect(result.lengthDots).toBe(65 + mmToDots(2));
	});

	it("skips the same oversized element in a scale-16 preview as in print", async () => {
		const doc = label([rect("huge", 0, 0, 1900, 1900), rect("r", 10, 5, 20, 30)], {
			length: { mode: "fixed", mm: 40 },
		});
		const preview = await renderLabel(doc, { tape, mode: "design", scale: 16 }, serverFonts);
		const printed = await print(doc);

		expect(preview.warnings).toContain("huge is too large to draw");
		expect(printed.warnings).toContain("huge is too large to draw");
		expect(preview.frame.data.filter((value) => value > 0)).toHaveLength(600 * 16 * 16);
		expect(at(preview.frame, 10 * 16, 5 * 16)).toBe(255);
		expect(at(preview.frame, 0, 0)).toBe(0);
	});

	it("lowers the preview scale so no bitmap of a long, zoomed label exceeds 16 MiB", async () => {
		const doc = label([rect("big", 0, 0, 1800, 1800), rect("r", 10, 5, 20, 30)], {
			tapeMm: 24,
			length: { mode: "fixed", mm: 1000 },
		});

		vi.mocked(bitmap).mockClear();

		const preview = await renderLabel(
			doc,
			{ tape: tapeGeometry(24), mode: "design", scale: 16 },
			serverFonts,
		);
		const sizes = vi.mocked(bitmap).mock.calls.map(([w, h]) => w * h);

		expect(preview.scale).toBeLessThan(16);
		expect(preview.frame.width).toBe(mmToDots(1000) * preview.scale);
		expect(at(preview.frame, 10 * preview.scale, 5 * preview.scale)).toBe(255);
		expect(sizes.length).toBeGreaterThan(1);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(1 << 24);
	});

	it("keeps the requested scale when the label is small enough", async () => {
		const preview = await renderLabel(
			label([rect("r", 10, 5, 20, 30)], { length: { mode: "fixed", mm: 40 } }),
			{ tape, mode: "design", scale: 16 },
			serverFonts,
		);

		expect(preview.scale).toBe(16);
	});

	it("skips an element too large to allocate and still draws the rest", async () => {
		const result = await print(label([rect("huge", 0, 0, 20_000, 1000), rect("r", 10, 5, 20, 30)]));

		expect(result.warnings).toContain("huge is too large to draw");
		expect(bounds(result.frame)).toEqual({ count: 600, x0: 10, x1: 29, y0: 5, y1: 34 });
	});

	it("clips elements to the band", async () => {
		const result = await print(label([rect("r", 0, 60, 10, 30)]));

		expect(bounds(result.frame)).toEqual({ count: 100, x0: 0, x1: 9, y0: 60, y1: 69 });
	});
});

describe("text", () => {
	it("fills the box: the largest size whose line box fits it", async () => {
		const el = text("t", "Hlg");
		const result = await print(label([el]));
		const ink = bounds(result.frame);

		expect(ink.x0).toBeGreaterThanOrEqual(el.x);
		expect(ink.x1).toBeLessThan(el.x + el.w);
		expect(ink.y0 - el.y).toBeGreaterThanOrEqual(0);
		expect(ink.y0 - el.y).toBeLessThanOrEqual(2);
		expect(el.y + el.h - 1 - ink.y1).toBeGreaterThanOrEqual(0);
		expect(el.y + el.h - 1 - ink.y1).toBeLessThanOrEqual(2);
	});

	it.each(["fill", "fixed"] as const)(
		"puts the baseline in the same row whatever glyphs the text holds (%s)",
		async (fit) => {
			const settings = { fit, size: fit === "fill" ? 200 : 24, align: "left", w: 300 } as const;
			const alone = (await print(label([text("t", "H", settings)]))).frame;
			const mixed = (await print(label([text("t", "Hgy", settings)]))).frame;
			const h = bounds(alone);
			const crop = (frame: Bitmap): number[] =>
				Array.from({ length: (h.x1 + 1) * frame.height }, (_, i) =>
					at(frame, i % (h.x1 + 1), Math.floor(i / (h.x1 + 1))),
				);

			expect(h.count).toBeGreaterThan(100);
			expect(crop(mixed)).toEqual(crop(alone));
		},
	);

	it("lets accents ink past the line box instead of clipping them", async () => {
		const el = text("t", "É", { y: 20, h: 30 });
		const ink = bounds((await print(label([el]))).frame);

		expect(ink.y0).toBeLessThan(el.y - 2);
		expect(ink.y1).toBeLessThan(el.y + el.h);
	});

	it("reports the laid-out width for auto-width text", async () => {
		const el = text("t", "Hi", { widthMode: "auto", w: 1, align: "left" });
		const result = await print(label([el], { length: { mode: "auto" } }));
		const ink = bounds(result.frame);

		expect(result.boxes.t.w).toBeGreaterThan(10);
		expect(ink.x1).toBeLessThan(el.x + result.boxes.t.w);
		expect(result.lengthDots).toBe(el.x + result.boxes.t.w + mmToDots(2));
	});

	it("interpolates variables and stacks lines", async () => {
		const one = await renderLabel(
			label([text("t", "{{a}}", { fit: "fixed", size: 20 })]),
			{ tape, vars: { a: "X" } },
			serverFonts,
		);
		const two = await print(label([text("t", "X\nX", { fit: "fixed", size: 20 })]));

		expect(bounds(one.frame).count).toBeGreaterThan(0);
		expect(bounds(two.frame).count).toBe(2 * bounds(one.frame).count);
	});

	it("warns about glyphs the font lacks and still draws the rest", async () => {
		const result = await print(label([text("t", "A中")]));

		expect(result.warnings).toContain('Inter has no glyph for "中"; it prints as a box');
		expect(bounds(result.frame).count).toBeGreaterThan(0);
	});

	it("falls back to the default font for an unknown family", async () => {
		const result = await print(label([text("t", "A", { font: "comic" })]));

		expect(result.warnings).toContain('Unknown font "comic"; using Inter');
		expect(bounds(result.frame).count).toBeGreaterThan(0);
	});
});

describe("codes", () => {
	it("escapes Wi-Fi template fields before encoding its QR payload", async () => {
		const template = QR.find((item) => item.id === "builtin:wifi-qr");

		if (!template) {
			throw new Error("Wi-Fi QR template is missing");
		}

		const wifi = template.doc.elements.find(
			(element): element is CodeElement => element.kind === "code",
		);

		if (!wifi) {
			throw new Error("Wi-Fi QR code is missing");
		}

		const { escapeFields: _escapeFields, ...plainWifi } = wifi;
		const vars = { ssid: "Cafe;5G", password: 'a:b"c' };
		const fromTemplate = await renderLabel(
			{ ...template.doc, elements: [wifi] },
			{ tape: tapeGeometry(24), vars },
			serverFonts,
		);
		const literal = await renderLabel(
			{
				...template.doc,
				elements: [{ ...plainWifi, data: 'WIFI:T:WPA;S:Cafe\\;5G;P:a\\:b\\"c;;' }],
			},
			{ tape: tapeGeometry(24) },
			serverFonts,
		);
		const unescaped = await renderLabel(
			{ ...template.doc, elements: [{ ...wifi, escapeFields: false }] },
			{ tape: tapeGeometry(24), vars },
			serverFonts,
		);

		expect(fromTemplate.frame.data).toEqual(literal.frame.data);
		expect(fromTemplate.frame.data).not.toEqual(unescaped.frame.data);
	});

	it.each(["L", "H"] as const)(
		"draws a QR (ECC %s) whose module grid reads back as bwip-js's matrix",
		async (ecc) => {
			const data = "https://example.com/label";
			const result = await print(label([code("q", "qr", data, { ecc })]));
			const options = { bcid: "qrcode", text: data, eclevel: ecc };
			const [symbol] = bwip.raw(options) as { pixs: number[]; pixx: number }[];
			const ink = bounds(result.frame);
			const module = (ink.x1 - ink.x0 + 1) / symbol.pixx;
			const read: number[] = [];

			for (let row = 0; row < symbol.pixx; row++) {
				for (let col = 0; col < symbol.pixx; col++) {
					const x = ink.x0 + Math.floor((col + 0.5) * module);
					const y = ink.y0 + Math.floor((row + 0.5) * module);

					read.push(at(result.frame, x, y) ? 1 : 0);
				}
			}

			expect(Number.isInteger(module)).toBe(true);
			expect(ink.x0).toBeGreaterThanOrEqual(module);
			expect(read).toEqual(symbol.pixs);
		},
	);

	it("sizes a small QR at 2 dots per module, keeping one module of quiet zone", async () => {
		const data = "https://example.com/asset/0042";
		const options = { bcid: "qrcode", text: data, eclevel: "M" };
		const [symbol] = bwip.raw(options) as { pixx: number }[];
		const result = await print(label([code("q", "qr", data, { x: 3, y: 3, w: 64, h: 64 })]));
		const ink = bounds(result.frame);

		expect(symbol.pixx).toBeGreaterThanOrEqual(25);
		expect(ink.x1 - ink.x0 + 1).toBe(2 * symbol.pixx);
		expect(ink.x0 - 3).toBeGreaterThanOrEqual(2);
		expect(result.warnings).toEqual([]);
	});

	it("warns when a 2D code is down to 1 dot per module", async () => {
		const result = await print(
			label([code("q", "qr", "https://example.com/asset/0042", { w: 40, h: 40 })]),
		);

		expect(result.warnings).toEqual([
			"QR code is too dense to scan reliably at this size; make it larger",
		]);

		expect(bounds(result.frame).count).toBeGreaterThan(0);
	});

	it("draws EAN-13 bars matching the published encoding", async () => {
		const L = [
			"0001101",
			"0011001",
			"0010011",
			"0111101",
			"0100011",
			"0110001",
			"0101111",
			"0111011",
			"0110111",
			"0001011",
		];
		const G = [
			"0100111",
			"0110011",
			"0011011",
			"0100001",
			"0011101",
			"0111001",
			"0000101",
			"0010001",
			"0001001",
			"0010111",
		];
		const R = L.map((bits) =>
			bits
				.split("")
				.map((bit) => (bit === "1" ? "0" : "1"))
				.join(""),
		);
		const digits = "5901234123457".split("").map(Number);
		const parity = "LGGLLG";
		const left = digits
			.slice(1, 7)
			.map((d, i) => (parity[i] === "L" ? L : G)[d])
			.join("");
		const right = digits
			.slice(7)
			.map((d) => R[d])
			.join("");
		const expected = `101${left}01010${right}101`;
		const result = await print(
			label([code("e", "ean13", "5901234123457", { w: 300 })], {
				length: { mode: "fixed", mm: 50 },
			}),
		);
		const ink = bounds(result.frame);
		const module = (ink.x1 - ink.x0 + 1) / 95;
		let read = "";

		for (let i = 0; i < 95; i++) {
			read += at(result.frame, ink.x0 + Math.floor((i + 0.5) * module), 10) ? "1" : "0";
		}

		expect(Number.isInteger(module)).toBe(true);
		expect(read).toBe(expected);
	});

	it("prints human-readable digits under a 1D code", async () => {
		const result = await print(label([code("c", "code128", "AB12", { showText: true })]));
		const ink = bounds(result.frame);
		const row = (y: number) =>
			Array.from({ length: result.frame.width }, (_, x) => at(result.frame, x, y)).some(Boolean);

		expect(ink.y1).toBeGreaterThan(55);
		expect(row(ink.y1 - 2)).toBe(true);
		expect(Array.from({ length: 70 }, (_, y) => row(y)).includes(false)).toBe(true);
	});

	it("turns invalid data into a warning and an empty box", async () => {
		const result = await print(label([code("e", "ean13", "59012341234X"), code("q", "qr", "")]));

		expect(result.warnings).toEqual([
			"EAN-13: EAN-13 must contain only digits",
			"QR code has no data",
		]);

		expect(bounds(result.frame).count).toBe(0);
	});
});

describe("images", () => {
	it("dithers a 50% gray patch to about half its dots", async () => {
		const result = await print(
			label([
				image(
					"i",
					Array.from({ length: 40 * 40 }, () => 128),
					40,
					40,
					{ mode: "dither" },
				),
			]),
		);
		const share = bounds(result.frame).count / (40 * 40);

		expect(share).toBeGreaterThan(0.45);
		expect(share).toBeLessThan(0.55);
	});

	it("thresholds in print mode and keeps grayscale ink in design mode", async () => {
		const pixels = Array.from({ length: 8 * 8 }, (_, i) => (i % 8 < 4 ? 40 : 200));
		const el = image("i", pixels, 8, 8, { w: 16, h: 16 });
		const printed = await print(label([el]));
		const designed = await renderLabel(
			label([el]),
			{ tape, mode: "design", scale: 2 },
			serverFonts,
		);

		expect(bounds(printed.frame)).toEqual({ count: 128, x0: 0, x1: 7, y0: 0, y1: 15 });
		expect(at(designed.frame, 0, 0)).toBe(215);
		expect(at(designed.frame, 31, 0)).toBe(55);
	});

	it("area-averages when shrinking", async () => {
		const checker = Array.from({ length: 4 * 4 }, (_, i) =>
			(i + Math.floor(i / 4)) % 2 ? 255 : 0,
		);
		const el = image("i", checker, 4, 4, { w: 2, h: 2 });
		const result = await renderLabel(label([el]), { tape, mode: "design", scale: 1 }, serverFonts);

		expect([at(result.frame, 0, 0), at(result.frame, 1, 1)]).toEqual([128, 128]);
	});
});

describe("modes", () => {
	const mixed = (): LabelDoc =>
		label([
			text("t", "Kitchen", { x: 0, y: 0, w: 100, h: 50 }),
			text("s", "{{date}}", { x: 0, y: 52, w: 100, h: 16, bold: true, italic: true, rotate: 180 }),
			{
				...base,
				id: "i",
				kind: "icon",
				icon: "triangle-alert",
				stroke: 2,
				x: 104,
				y: 4,
				w: 40,
				h: 40,
			},
			rect("b", 150, 4, 30, 30, { fill: false, stroke: 2, radius: 6, dashed: true }),
			rect("e", 150, 36, 30, 30, { shape: "ellipse", invert: true }),
			code("q", "qr", "hello", { x: 185, y: 0, w: 70, h: 70, rotate: 90 }),
			code("c", "code128", "A1", { x: 260, y: 0, w: 120, h: 70, showText: true }),
		]);

	it("renders design mode at scale 1 identical to print mode", async () => {
		const printed = await print(mixed());
		const designed = await renderLabel(mixed(), { tape, mode: "design", scale: 1 }, serverFonts);

		expect(printed.warnings).toEqual([]);
		expect(bounds(printed.frame).count).toBeGreaterThan(1000);
		expect(designed.raster).toBeNull();
		expect(designed.frame).toEqual(printed.frame);
	});

	it("scales design-mode geometry by the scale", async () => {
		const designed = await renderLabel(
			label([rect("r", 10, 5, 20, 30)]),
			{ tape, mode: "design", scale: 4 },
			serverFonts,
		);

		expect(designed.frame.width).toBe(4 * mmToDots(30));
		expect(bounds(designed.frame)).toEqual({ count: 600 * 16, x0: 40, x1: 119, y0: 20, y1: 139 });
	});

	it("warns about an unknown icon and never throws on user data", async () => {
		const result = await print(
			label([
				{
					...base,
					id: "i",
					kind: "icon",
					icon: "no-such-icon",
					stroke: 2,
					x: 0,
					y: 0,
					w: 20,
					h: 20,
				},
				rect("n", Number.NaN, 0, 5, 5),
			]),
		);

		expect(result.warnings).toEqual(['Unknown icon "no-such-icon"']);
		expect(bounds(result.frame).count).toBe(0);
	});

	it("rejects a bad scale as a programmer error", async () => {
		await expect(
			renderLabel(label([]), { tape, mode: "design", scale: 1.5 }, serverFonts),
		).rejects.toThrow(RangeError);
	});
});
