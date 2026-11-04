import type { Bitmap, TextAlign, TextFit, VerticalAlign } from "$lib/doc";
import type { Glyph } from "opentype.js";

import type { Face } from "./fonts.ts";
import { fill, PathBuilder } from "./raster.ts";

/** What text layout needs from a text element; code labels reuse it for their digits. */
export interface TextSpec {
	text: string;
	size: number;
	align: TextAlign;
	valign: VerticalAlign;
	lineHeight: number;
	tracking: number;
	fit: TextFit;
}

interface Bounds {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

/** One line measured in font units, so any size is a linear rescale. */
interface MeasuredLine {
	glyphs: Glyph[];
	pens: number[];
	bounds: (Bounds | null)[];
}

interface LineBox {
	left: number;
	right: number;
	ascent: number;
	descent: number;
	inked: boolean;
}

export interface PlacedGlyph {
	glyph: Glyph;
	x: number;
	baseline: number;
}

export interface TextLayout {
	/** Resolved em size in dots. */
	size: number;
	/** Width of the widest line's extent in dots. */
	width: number;
	glyphs: PlacedGlyph[];
	overflow: boolean;
	missing: string[];
}

const boundsCache = new WeakMap<Glyph, Bounds | null>();

function glyphBounds(glyph: Glyph): Bounds | null {
	const known = boundsCache.get(glyph);

	if (known !== undefined) {
		return known;
	}

	let bounds: Bounds | null = null;

	if (glyph.path.commands.length > 0) {
		const box = glyph.path.getBoundingBox();

		bounds = { xMin: box.x1, xMax: box.x2, yMin: box.y1, yMax: box.y2 };
	}

	boundsCache.set(glyph, bounds);

	return bounds;
}

function measure(face: Face, line: string): MeasuredLine {
	const glyphs = face.font.stringToGlyphs(line);
	const pens: number[] = [];
	let pen = 0;

	for (const [i, glyph] of glyphs.entries()) {
		if (i > 0) {
			pen += face.kern(glyphs[i - 1].index, glyph.index);
		}

		pens.push(pen);
		pen += glyph.advanceWidth ?? 0;
	}

	return { glyphs, pens, bounds: glyphs.map(glyphBounds) };
}

/** A line's ink extent at scale `k`: alignment and fitting both work on ink, not advances. */
function lineBox(line: MeasuredLine, k: number, tracking: number): LineBox {
	const box: LineBox = { left: 0, right: 0, ascent: 0, descent: 0, inked: false };

	for (const [i, bounds] of line.bounds.entries()) {
		if (!bounds) {
			continue;
		}

		const pen = line.pens[i] * k + i * tracking;
		const left = pen + bounds.xMin * k;
		const right = pen + bounds.xMax * k;

		if (box.inked) {
			box.left = Math.min(box.left, left);
			box.right = Math.max(box.right, right);
			box.ascent = Math.max(box.ascent, bounds.yMax * k);
			box.descent = Math.min(box.descent, bounds.yMin * k);
		} else {
			Object.assign(box, {
				left,
				right,
				ascent: bounds.yMax * k,
				descent: bounds.yMin * k,
				inked: true,
			});
		}
	}

	return box;
}

interface Block {
	lines: LineBox[];
	width: number;
	top: number;
	bottom: number;
}

function block(lines: MeasuredLine[], face: Face, size: number, spec: TextSpec): Block {
	const k = size / face.font.unitsPerEm;
	const boxes = lines.map((line) => lineBox(line, k, spec.tracking));
	let top = Infinity;
	let bottom = -Infinity;

	for (const [i, box] of boxes.entries()) {
		if (box.inked) {
			const baseline = i * spec.lineHeight * size;

			top = Math.min(top, baseline - box.ascent);
			bottom = Math.max(bottom, baseline - box.descent);
		}
	}

	if (top > bottom) {
		top = 0;
		bottom = 0;
	}

	const width = Math.max(0, ...boxes.map((box) => box.right - box.left));

	return { lines: boxes, width, top, bottom };
}

const EPSILON = 1e-6;

/**
 * Lay out `spec` in a `width × height` dot box. Pass `width = Infinity` for auto width; the
 * result's `width` is then the box to report.
 */
export function layoutText(spec: TextSpec, face: Face, width: number, height: number): TextLayout {
	const text = spec.text.replaceAll("\r", "").replaceAll("\t", " ");
	const lines = text.split("\n").map((line) => measure(face, line));
	const missing = Array.from(new Set(Array.from(text))).filter(
		(char) => char !== "\n" && !face.font.charToGlyphIndex(char),
	);
	const fits = (size: number): boolean => {
		const b = block(lines, face, size, spec);

		return b.width <= width + EPSILON && b.bottom - b.top <= height + EPSILON;
	};

	let size = Math.max(1, spec.size);
	let overflow = false;

	if (spec.fit === "fixed") {
		overflow = !fits(size);
	} else {
		let lo = 1;
		let hi = Math.max(1, Math.floor(spec.size));

		if (fits(lo)) {
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);

				if (fits(mid)) {
					lo = mid;
				} else {
					hi = mid - 1;
				}
			}
		} else {
			overflow = true;
		}

		size = lo;
	}

	const b = block(lines, face, size, spec);
	const boxWidth = Number.isFinite(width) ? width : b.width;
	const boxHeight = height;
	const k = size / face.font.unitsPerEm;
	const top =
		spec.valign === "top"
			? -b.top
			: spec.valign === "bottom"
				? boxHeight - b.bottom
				: (boxHeight - (b.bottom - b.top)) / 2 - b.top;
	const glyphs: PlacedGlyph[] = [];

	for (const [i, line] of lines.entries()) {
		const box = b.lines[i];
		const extent = box.right - box.left;
		const x =
			spec.align === "left"
				? -box.left
				: spec.align === "right"
					? boxWidth - box.right
					: (boxWidth - extent) / 2 - box.left;
		const baseline = top + i * spec.lineHeight * size;

		for (const [j, glyph] of line.glyphs.entries()) {
			if (line.bounds[j]) {
				glyphs.push({ glyph, x: x + line.pens[j] * k + j * spec.tracking, baseline });
			}
		}
	}

	return { size, width: b.width, glyphs, overflow, missing };
}

/**
 * Fill the laid-out glyphs into `target` at `scale` pixels per dot, with the layout box's top-left
 * corner at dot `(dx, dy)`.
 */
export function drawText(
	target: Bitmap,
	layout: TextLayout,
	face: Face,
	scale: number,
	dx = 0,
	dy = 0,
): void {
	const k = (layout.size / face.font.unitsPerEm) * scale;

	for (const { glyph, x, baseline } of layout.glyphs) {
		const path = new PathBuilder().transform(k, -k, (dx + x) * scale, (dy + baseline) * scale);

		for (const command of glyph.path.commands) {
			switch (command.type) {
				case "M":
					path.moveTo(command.x, command.y);

					break;
				case "L":
					path.lineTo(command.x, command.y);

					break;
				case "Q":
					path.quadTo(command.x1, command.y1, command.x, command.y);

					break;
				case "C":
					path.cubicTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);

					break;
				case "Z":
					path.close();

					break;
			}
		}

		fill(target, path.lines);
	}
}
