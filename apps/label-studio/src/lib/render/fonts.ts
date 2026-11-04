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

	const loading = source.load(file).then(async (bytes) => ({
		font: parse(bytes),
		kern: await readKerning(bytes),
	}));

	faces.set(file, loading);
	loading.catch(() => faces.delete(file));

	return loading;
}
