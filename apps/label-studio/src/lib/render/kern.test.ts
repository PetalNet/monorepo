import { serverFonts } from "$lib/server/fonts";
import { parse } from "opentype.js";
import { describe, expect, it } from "vitest";

import { readKerning } from "./kern.ts";

const load = async (file: string) => {
	const bytes = await serverFonts.load(file);

	return { font: parse(bytes), kern: await readKerning(bytes) };
};

const pairs = ["AV", "To", "Ty", "LT", "Yo", "av", "r.", "F,"];

describe("readKerning", () => {
	it("agrees with opentype.js on fonts without extension lookups", async () => {
		const { font, kern } = await load("nunito/regular.woff");

		for (const pair of pairs) {
			const [left, right] = font.stringToGlyphs(pair);

			expect(kern(left.index, right.index)).toBe(font.getKerningValue(left, right));
		}

		expect(kern(font.charToGlyph("A").index, font.charToGlyph("V").index)).toBeLessThan(0);
	});

	it.each(["inter/regular.woff", "source-serif/regular.woff"])(
		"reads kerning opentype.js misses in %s",
		async (file) => {
			const { font, kern } = await load(file);
			const [a, v] = font.stringToGlyphs("AV");

			expect(font.getKerningValue(a, v)).toBe(0);
			expect(kern(a.index, v.index)).toBeLessThan(0);
		},
	);
});
