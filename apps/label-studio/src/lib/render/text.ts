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

/** One line measured in font units, so any size is a linear rescale. */
interface MeasuredLine {
	glyphs: Glyph[];
	pens: number[];
	/** Pen position after the last glyph: the line's advance width. */
	advance: number;
}

export interface PlacedGlyph {
	glyph: Glyph;
	x: number;
	baseline: number;
}

export interface TextLayout {
	/** Resolved em size in dots. */
	size: number;
	/** Advance width of the widest line in dots. */
	width: number;
	glyphs: PlacedGlyph[];
	overflow: boolean;
	missing: string[];
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

	return { glyphs, pens, advance: pen };
}

const lineWidth = (line: MeasuredLine, k: number, tracking: number): number =>
	line.advance * k + Math.max(0, line.glyphs.length - 1) * tracking;

/**
 * Lines stack on the face's line box (see `Face.ascent`), never on their own ink, so the baseline
 * depends only on font, size, line height, alignment and box: "ace" and "Ag" share it.
 */
const blockHeight = (face: Face, lines: number, size: number, lineHeight: number): number =>
	((lines - 1) * lineHeight + (face.ascent + face.descent) / face.font.unitsPerEm) * size;

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
	const upm = face.font.unitsPerEm;
	const widest = (size: number): number =>
		Math.max(0, ...lines.map((line) => lineWidth(line, size / upm, spec.tracking)));
	const fits = (size: number): boolean =>
		widest(size) <= width + EPSILON &&
		blockHeight(face, lines.length, size, spec.lineHeight) <= height + EPSILON;

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

	const k = size / upm;
	const textWidth = widest(size);
	const boxWidth = Number.isFinite(width) ? width : textWidth;
	const slack = height - blockHeight(face, lines.length, size, spec.lineHeight);
	const top = spec.valign === "top" ? 0 : spec.valign === "bottom" ? slack : slack / 2;
	const glyphs: PlacedGlyph[] = [];

	for (const [i, line] of lines.entries()) {
		const extent = lineWidth(line, k, spec.tracking);
		const x =
			spec.align === "left"
				? 0
				: spec.align === "right"
					? boxWidth - extent
					: (boxWidth - extent) / 2;
		// A whole-dot baseline keeps flat glyph bottoms crisp instead of splitting a row.
		const baseline = Math.round(top + face.ascent * k + i * spec.lineHeight * size);

		for (const [j, glyph] of line.glyphs.entries()) {
			if (glyph.path.commands.length > 0) {
				glyphs.push({ glyph, x: x + line.pens[j] * k + j * spec.tracking, baseline });
			}
		}
	}

	return { size, width: textWidth, glyphs, overflow, missing };
}

/** Dots of room around a text box for ink past its line box: accents, italic overhang. */
export const textBleed = (layout: TextLayout): number => Math.ceil(layout.size / 2);

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

		fill(target, path.lines, true);
	}
}
