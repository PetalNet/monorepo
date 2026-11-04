import {
	HEAD_PINS,
	interpolate,
	mmToDots,
	type Bitmap,
	type Box,
	type ElementKind,
	type LabelDoc,
	type LabelElement,
	type RenderOptions,
	type RenderResult,
	type Rotation,
	type Vars,
} from "$lib/doc";

import { drawCode, encode, loadBarcodes, type Barcodes } from "./code.ts";
import {
	DEFAULT_FONT,
	findFamily,
	fontStyle,
	loadFace,
	type Face,
	type FontFamily,
} from "./fonts.ts";
import { drawIcon, loadIcons, type IconSet } from "./icon.ts";
import { decodeGray, drawImage } from "./image.ts";
import { bitmap } from "./raster.ts";
import { drawBorder, drawShape } from "./shape.ts";
import { drawText, layoutText, textBleed } from "./text.ts";

/** Loads font bytes for a family/style. The browser fetches them; the server reads files. */
export interface FontSource {
	load: (file: string) => Promise<ArrayBuffer>;
}

/** Longest label the renderer will lay out; longer fixed lengths are clamped. */
const MAX_LENGTH_MM = 1000;
const MAX_SCALE = 16;

interface Assets {
	faces: ReadonlyMap<string, Face>;
	icons: IconSet | null;
	barcodes: Barcodes | null;
}

interface Context {
	assets: Assets;
	vars: Vars;
	mode: "print" | "design";
	scale: number;
	warn: (message: string) => void;
}

/**
 * Draws an element's content, unrotated, into a layer of its local box at render scale. The layer
 * extends `bleed` dots past the box on every side; the box's top-left is at dot (bleed, bleed).
 */
type Draw = (layer: Bitmap, w: number, h: number, bleed: number) => void;

/** An element ready to draw: its local width (auto-width text resolves it), or null to skip. */
interface Prepared {
	width?: number;
	/** Dots the content may ink past its box, like CSS overflow: visible. */
	bleed?: number;
	draw: Draw;
}

type Preparer<K extends ElementKind> = (
	el: Extract<LabelElement, { kind: K }>,
	w: number,
	h: number,
	ctx: Context,
) => Prepared | null;

const BARCODE_FONT = { family: DEFAULT_FONT, style: "regular" } as const;

function textFamily(font: string, warn: (message: string) => void): FontFamily {
	const family = findFamily(font) ?? findFamily(DEFAULT_FONT);

	if (!family) {
		throw new Error(`renderLabel: default font ${DEFAULT_FONT} is not registered`);
	}

	if (family.id !== font) {
		warn(`Unknown font "${font}"; using ${family.label}`);
	}

	return family;
}

const PREPARE: { [K in ElementKind]: Preparer<K> } = {
	text(el, w, h, ctx) {
		const family = textFamily(el.font, ctx.warn);
		const face = ctx.assets.faces.get(family.files[fontStyle(el.bold, el.italic)]);

		if (!face) {
			return null;
		}

		const auto = el.widthMode === "auto";
		const layout = layoutText(
			{ ...el, text: interpolate(el.text, ctx.vars) },
			face,
			auto ? Infinity : w,
			h,
		);

		for (const char of layout.missing) {
			ctx.warn(`${family.label} has no glyph for "${char}"; it prints as a box`);
		}

		if (layout.overflow && el.fit !== "fixed") {
			ctx.warn(`Some text doesn't fit its box even at the smallest size`);
		}

		return {
			width: auto ? Math.max(1, Math.ceil(layout.width)) : w,
			bleed: textBleed(layout),
			draw(layer, _w, _h, bleed) {
				drawText(layer, layout, face, ctx.scale, bleed, bleed);
			},
		};
	},
	icon(el, _w, _h, ctx) {
		const icon = ctx.assets.icons?.(el.icon);

		if (!icon) {
			if (ctx.assets.icons) {
				ctx.warn(`Unknown icon "${el.icon}"`);
			}

			return null;
		}

		return {
			draw(layer, w, h) {
				drawIcon(layer, icon, w, h, el.stroke, ctx.scale);
			},
		};
	},
	shape(el, _w, _h, ctx) {
		return {
			draw(layer, w, h) {
				drawShape(layer, el, w, h, ctx.scale);
			},
		};
	},
	image(el, _w, _h, ctx) {
		const gray = decodeGray(el);

		if (typeof gray === "string") {
			ctx.warn(gray);

			return null;
		}

		return {
			draw(layer) {
				drawImage(layer, el, gray, ctx.mode);
			},
		};
	},
	code(el, _w, _h, ctx) {
		if (!ctx.assets.barcodes) {
			return null;
		}

		const symbol = encode(ctx.assets.barcodes, el, interpolate(el.data, ctx.vars));

		if (typeof symbol === "string") {
			ctx.warn(symbol);

			return null;
		}

		const family = findFamily(BARCODE_FONT.family);
		const face = family ? (ctx.assets.faces.get(family.files[BARCODE_FONT.style]) ?? null) : null;

		return {
			draw(layer, w, h) {
				const problem = drawCode(layer, el, symbol, w, h, ctx.scale, face);

				if (problem) {
					ctx.warn(problem);
				}
			},
		};
	},
};

function prepare(el: LabelElement, w: number, h: number, ctx: Context): Prepared | null {
	switch (el.kind) {
		case "text":
			return PREPARE.text(el, w, h, ctx);
		case "icon":
			return PREPARE.icon(el, w, h, ctx);
		case "shape":
			return PREPARE.shape(el, w, h, ctx);
		case "image":
			return PREPARE.image(el, w, h, ctx);
		case "code":
			return PREPARE.code(el, w, h, ctx);
	}
}

/** Every font file, plus the icon set and barcode encoder, that this document needs. */
async function loadAssets(
	doc: LabelDoc,
	fonts: FontSource,
	warn: (message: string) => void,
): Promise<Assets> {
	const files = new Set<string>();
	let icons = false;
	let codes = false;

	for (const el of doc.elements) {
		if (el.kind === "text") {
			const family = findFamily(el.font) ?? findFamily(DEFAULT_FONT);

			if (family) {
				files.add(family.files[fontStyle(el.bold, el.italic)]);
			}
		} else if (el.kind === "icon") {
			icons = true;
		} else if (el.kind === "code") {
			codes = true;
			const family = findFamily(BARCODE_FONT.family);

			if (el.showText && family) {
				files.add(family.files[BARCODE_FONT.style]);
			}
		}
	}

	const faces = new Map<string, Face>();
	const [loadedFaces, iconSet, barcodes] = await Promise.all([
		Promise.allSettled(
			[...files].map(async (file) => faces.set(file, await loadFace(fonts, file))),
		),
		icons ? loadIcons().catch(() => null) : null,
		codes ? loadBarcodes().catch(() => null) : null,
	]);

	for (const [i, result] of loadedFaces.entries()) {
		if (result.status === "rejected") {
			warn(`Font ${[...files][i]} failed to load; its text is not drawn`);
		}
	}

	if (icons && !iconSet) {
		warn("Icons failed to load");
	}

	if (codes && !barcodes) {
		warn("The barcode encoder failed to load");
	}

	return { faces, icons: iconSet, barcodes };
}

/** Integer box in dots, or null when the stored geometry isn't usable. */
function snap(box: Box): Box | null {
	const values = [box.x, box.y, box.w, box.h];

	if (!values.every(Number.isFinite)) {
		return null;
	}

	const [x, y, w, h] = values.map(Math.round);

	return w > 0 && h > 0 ? { x, y, w, h } : null;
}

const quarterTurn = (rotate: Rotation): boolean => rotate === 90 || rotate === 270;

/**
 * Composite an element layer (its unrotated local box) onto the frame, turning it clockwise by
 * `rotate`. Normal layers add ink; inverted layers replace the whole box with ink and knock the
 * content out.
 */
function blit(
	frame: Bitmap,
	layer: Bitmap,
	x0: number,
	y0: number,
	rotate: Rotation,
	invert: boolean,
): void {
	const { width: lw, height: lh } = layer;

	for (let ly = 0; ly < lh; ly++) {
		for (let lx = 0; lx < lw; lx++) {
			let fx: number;
			let fy: number;

			switch (rotate) {
				case 0:
					fx = x0 + lx;
					fy = y0 + ly;

					break;
				case 90:
					fx = x0 + lh - 1 - ly;
					fy = y0 + lx;

					break;
				case 180:
					fx = x0 + lw - 1 - lx;
					fy = y0 + lh - 1 - ly;

					break;
				case 270:
					fx = x0 + ly;
					fy = y0 + lw - 1 - lx;

					break;
			}

			if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) {
				continue;
			}

			const value = layer.data[ly * lw + lx];
			const at = fy * frame.width + fx;

			if (invert) {
				frame.data[at] = 255 - value;
			} else if (value > frame.data[at]) {
				frame.data[at] = value;
			}
		}
	}
}

/**
 * Draw a label document. The browser preview and the server's print path call this same function,
 * so the preview in "print" mode is byte-for-byte the printed raster.
 */
export async function renderLabel(
	doc: LabelDoc,
	options: RenderOptions,
	fonts: FontSource,
): Promise<RenderResult> {
	const mode = options.mode ?? "print";
	const scale = mode === "print" ? 1 : (options.scale ?? 1);

	if (!Number.isInteger(scale) || scale < 1 || scale > MAX_SCALE) {
		throw new RangeError(
			`renderLabel: scale must be an integer from 1 to ${String(MAX_SCALE)}, got ${String(scale)}`,
		);
	}

	const warnings = new Set<string>();
	const warn = (message: string): void => {
		warnings.add(message);
	};

	const { tape } = options;

	if (doc.tapeMm !== tape.widthMm) {
		warn(`Designed for ${String(doc.tapeMm)} mm tape, rendering for ${String(tape.widthMm)} mm`);
	}

	const ctx: Context = {
		assets: await loadAssets(doc, fonts, warn),
		vars: options.vars ?? {},
		mode,
		scale,
		warn,
	};
	const vertical = doc.orientation === "vertical";
	const boxes: Record<string, Box> = {};
	const items: {
		box: Box;
		local: [number, number];
		bleed: number;
		el: LabelElement;
		draw: Draw;
	}[] = [];
	let furthest = 0;

	for (const el of doc.elements) {
		const box = snap(el);

		if (!box) {
			continue;
		}

		const turned = quarterTurn(el.rotate);
		const [lw, lh] = turned ? [box.h, box.w] : [box.w, box.h];
		const prepared = prepare(el, lw, lh, ctx);
		const width = prepared?.width ?? lw;
		const resolved = turned ? { ...box, h: width } : { ...box, w: width };

		boxes[el.id] = turned
			? { x: el.x, y: el.y, w: el.w, h: width }
			: { x: el.x, y: el.y, w: width, h: el.h };

		furthest = Math.max(furthest, vertical ? resolved.y + resolved.h : resolved.x + resolved.w);

		if (prepared) {
			// An inverted layer paints its whole extent, so it must stop at the box.
			const bleed = el.invert ? 0 : (prepared.bleed ?? 0);

			items.push({ box: resolved, local: [width, lh], bleed, el, draw: prepared.draw });
		}
	}

	const maxLength = mmToDots(MAX_LENGTH_MM);
	let lengthDots =
		doc.length.mode === "auto" ? furthest + mmToDots(doc.margin.endMm) : mmToDots(doc.length.mm);

	if (!Number.isFinite(lengthDots) || lengthDots > maxLength) {
		warn(`Labels can be at most ${String(MAX_LENGTH_MM)} mm long`);
		lengthDots = maxLength;
	}

	lengthDots = Math.max(1, Math.round(lengthDots));

	const [frameW, frameH] = vertical ? [tape.pins, lengthDots] : [lengthDots, tape.pins];
	const frame = bitmap(frameW * scale, frameH * scale);

	for (const { box, local, bleed, el, draw } of items) {
		const layer = bitmap((local[0] + 2 * bleed) * scale, (local[1] + 2 * bleed) * scale);

		// The bleed is the same on all four sides, so it survives any quarter turn unchanged.
		draw(layer, local[0], local[1], bleed);
		blit(frame, layer, (box.x - bleed) * scale, (box.y - bleed) * scale, el.rotate, el.invert);
	}

	if (doc.border) {
		drawBorder(frame, doc.border, frameW, frameH, scale);
	}

	if (doc.invert) {
		for (let i = 0; i < frame.data.length; i++) {
			frame.data[i] = 255 - frame.data[i];
		}
	}

	let raster: Bitmap | null = null;

	if (mode === "print") {
		raster = bitmap(lengthDots, HEAD_PINS);

		for (let y = 0; y < frameH; y++) {
			for (let x = 0; x < frameW; x++) {
				const [tx, row] = vertical ? [y, tape.pins - 1 - x] : [x, y];

				raster.data[(tape.margin + row) * lengthDots + tx] = frame.data[y * frameW + x];
			}
		}
	}

	return { frame, raster, lengthDots, boxes, warnings: [...warnings] };
}
