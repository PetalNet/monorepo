import type { Bitmap, CodeElement, Symbology } from "$lib/doc";
import type BwipJs from "bwip-js/generic";

import type { Face } from "./fonts.ts";
import { fillRect } from "./raster.ts";
import { drawText, layoutText } from "./text.ts";

export type Barcodes = typeof BwipJs;

/** Bwip-js with its encoder tables, imported only when a label has a code. */
export async function loadBarcodes(): Promise<Barcodes> {
	const module = await import("bwip-js/generic");

	return module.default;
}

type Spec =
	| { bcid: string; geometry: "matrix" }
	| { bcid: string; geometry: "bars"; quiet: readonly [left: number, right: number] };

/**
 * 1D quiet zones in modules, from each symbology's specification. 2D codes keep one module inside
 * the box: the blank tape around a label supplies the rest, and the specification's four-module QR
 * margin would halve the module size in a 64-dot box.
 */
const SYMBOLOGIES: Record<Symbology, Spec> = {
	qr: { bcid: "qrcode", geometry: "matrix" },
	datamatrix: { bcid: "datamatrix", geometry: "matrix" },
	code128: { bcid: "code128", geometry: "bars", quiet: [10, 10] },
	ean13: { bcid: "ean13", geometry: "bars", quiet: [11, 7] },
};

const MATRIX_QUIET = 1;

export type Encoded =
	| { geometry: "matrix"; cols: number; rows: number; dark: readonly number[] }
	| { geometry: "bars"; widths: readonly number[]; text: string };

const LABELS: Record<Symbology, string> = {
	qr: "QR code",
	datamatrix: "Data Matrix",
	code128: "Code 128",
	ean13: "EAN-13",
};

const eanCheckDigit = (digits: string): number => {
	let sum = 0;

	for (let i = 0; i < 12; i++) {
		sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
	}

	return (10 - (sum % 10)) % 10;
};

/**
 * Encode through bwip-js. Its error messages are already written for people, so they become the
 * warning.
 */
export function encode(barcodes: Barcodes, el: CodeElement, data: string): Encoded | string {
	const spec = SYMBOLOGIES[el.symbology];

	if (data === "") {
		return `${LABELS[el.symbology]} has no data`;
	}

	type Raw = { sbs: number[] } | { pixs: number[]; pixx: number; pixy: number };
	let result: Raw[];

	try {
		result = barcodes.raw({
			bcid: spec.bcid,
			text: data,
			...(el.symbology === "qr" ? { eclevel: el.ecc } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		return `${LABELS[el.symbology]}: ${message.replace(/^bwipp\.\w+#\d+: /, "")}`;
	}

	const [first] = result;

	if (spec.geometry === "matrix" && "pixs" in first) {
		return { geometry: "matrix", cols: first.pixx, rows: first.pixy, dark: first.pixs };
	}

	if (spec.geometry === "bars" && "sbs" in first) {
		const text =
			el.symbology === "ean13" ? `${data.slice(0, 12)}${String(eanCheckDigit(data))}` : data;

		return { geometry: "bars", widths: first.sbs, text };
	}

	return `${LABELS[el.symbology]}: unexpected encoder output`;
}

const tooSmall = (el: CodeElement): string =>
	`${LABELS[el.symbology]} doesn't fit its box; make it larger`;

/**
 * Draw a symbol with the largest integer module size in dots that fits the `w × h` box, centred. A
 * 2D code keeps a one-module quiet zone when it fits; a 1D code picks its module size from the bars
 * alone and keeps as much of its quiet zone as the spare width allows. Returns a warning.
 */
export function drawCode(
	target: Bitmap,
	el: CodeElement,
	symbol: Encoded,
	w: number,
	h: number,
	scale: number,
	face: Face | null,
): string | null {
	const spec = SYMBOLOGIES[el.symbology];
	const rect = (x: number, y: number, rw: number, rh: number): void => {
		fillRect(target, x * scale, y * scale, rw * scale, rh * scale);
	};

	if (symbol.geometry === "matrix") {
		const fit = (q: number): number =>
			Math.floor(Math.min(w / (symbol.cols + 2 * q), h / (symbol.rows + 2 * q)));
		const module = fit(MATRIX_QUIET) >= 1 ? fit(MATRIX_QUIET) : fit(0);

		if (module < 1) {
			return tooSmall(el);
		}

		const ox = Math.floor((w - symbol.cols * module) / 2);
		const oy = Math.floor((h - symbol.rows * module) / 2);

		for (let row = 0; row < symbol.rows; row++) {
			for (let col = 0; col < symbol.cols; col++) {
				if (symbol.dark[row * symbol.cols + col]) {
					rect(ox + col * module, oy + row * module, module, module);
				}
			}
		}

		return module === 1
			? `${LABELS[el.symbology]} is too dense to scan reliably at this size; make it larger`
			: null;
	}

	const [left, right] = spec.geometry === "bars" ? spec.quiet : [0, 0];
	const modules = symbol.widths.reduce((sum, width) => sum + width, 0);
	const module = Math.floor(w / modules);

	if (module < 1) {
		return tooSmall(el);
	}

	const spare = w - modules * module;
	const quiet = Math.min(spare, (left + right) * module);
	const ox = Math.floor((quiet * left) / (left + right) + (spare - quiet) / 2);
	const textHeight = Math.min(20, Math.max(7, Math.round(h * 0.24)));
	const gap = 1;
	const showText = el.showText && face !== null && h - textHeight - gap >= 4;
	const barHeight = showText ? h - textHeight - gap : h;
	let x = ox;

	for (const [i, width] of symbol.widths.entries()) {
		if (i % 2 === 0) {
			rect(x, 0, width * module, barHeight);
		}

		x += width * module;
	}

	if (showText) {
		const textWidth = modules * module;
		const layout = layoutText(
			{
				text: symbol.text,
				size: textHeight,
				align: "center",
				valign: "middle",
				lineHeight: 1,
				tracking: 0,
				fit: "fill",
			},
			face,
			textWidth,
			textHeight,
		);

		drawText(target, layout, face, scale, ox, barHeight + gap);
	}

	return null;
}
