import type { FontId } from "$lib/doc";
import { parse, type Font } from "opentype.js";

import type { FontSource } from "./index.ts";
import { readKerning, type Kerning } from "./kern.ts";

export type FontStyle = "regular" | "bold" | "italic" | "boldItalic";

export interface FontFamily {
	id: FontId;
	label: string;
	files: Record<FontStyle, string>;
}

const family = (id: FontId, label: string): FontFamily => ({
	id,
	label,
	files: {
		regular: `${id}/regular.woff`,
		bold: `${id}/bold.woff`,
		italic: `${id}/italic.woff`,
		boldItalic: `${id}/bold-italic.woff`,
	},
});

/** The bundled families, each with four static faces under `static/fonts/<id>/`. */
export const FONTS: readonly FontFamily[] = [
	family("inter", "Inter"),
	family("atkinson", "Atkinson Hyperlegible"),
	family("barlow-condensed", "Barlow Condensed"),
	family("jetbrains-mono", "JetBrains Mono"),
	family("source-serif", "Source Serif 4"),
	family("nunito", "Nunito"),
];

export const DEFAULT_FONT: FontId = "inter";

export const fontStyle = (bold: boolean, italic: boolean): FontStyle =>
	bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular";

export const findFamily = (id: FontId): FontFamily | undefined =>
	FONTS.find((entry) => entry.id === id);

/** Fetches faces from the app's `/fonts/` route. */
export const browserFonts: FontSource = {
	async load(file) {
		const response = await fetch(`/fonts/${file}`);

		if (!response.ok) {
			throw new Error(`font ${file}: HTTP ${String(response.status)}`);
		}

		return response.arrayBuffer();
	},
};

/** A parsed face: outlines and metrics from opentype.js, pair kerning from our GPOS reader. */
export interface Face {
	font: Font;
	kern: Kerning;
	/** Line box above and below the baseline in font units, both positive. */
	ascent: number;
	descent: number;
}

const ASCENDERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZbdfhklt0123456789";
const DESCENDERS = "gjpqy";

/**
 * The line box is the ink extent of plain Latin letters and digits, a constant of the face. The
 * font's own ascender/descender reserve room for accents and run 20-35% taller, which on a 70-dot
 * band costs a fifth of the cap height; glyphs beyond this box bleed past it instead.
 */
function lineBox(font: Font): Pick<Face, "ascent" | "descent"> {
	let ascent = 0;
	let descent = 0;

	for (const glyph of font.stringToGlyphs(ASCENDERS + DESCENDERS)) {
		const box = glyph.getBoundingBox();

		ascent = Math.max(ascent, box.y2);
		descent = Math.max(descent, -box.y1);
	}

	return { ascent, descent };
}

const cache = new WeakMap<FontSource, Map<string, Promise<Face>>>();

/** Load and parse a face once per source. A failed load is not cached, so it can be retried. */
export function loadFace(source: FontSource, file: string): Promise<Face> {
	let faces = cache.get(source);

	if (!faces) {
		faces = new Map();
		cache.set(source, faces);
	}

	const known = faces.get(file);

	if (known) {
		return known;
	}

	const loading = source.load(file).then(async (bytes) => {
		const font = parse(bytes);

		return { font, kern: await readKerning(bytes), ...lineBox(font) };
	});

	faces.set(file, loading);
	loading.catch(() => faces.delete(file));

	return loading;
}
