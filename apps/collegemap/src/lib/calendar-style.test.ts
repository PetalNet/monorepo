/**
 * The calendar surface's design rules, checked rather than trusted.
 *
 * Two things a reviewer finds by zooming in and diffing, and one they cannot find by looking at
 * all: contrast. All three are cheap to assert and expensive to re-litigate, so they live here.
 *
 * Colour targets: AAA (7:1) on every text pair, in both themes. Graphics that carry meaning get the
 * non-text bar (3:1); the day-cell season dot is held to 4.5:1 because at 6px across it is doing
 * that job at the very bottom of the size range.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "../routes/calendar/+page.svelte");
const SURFACE = [
	PAGE,
	path.join(HERE, "components/BreakDayDetail.svelte"),
	path.join(HERE, "components/BreakEditor.svelte"),
];

const THEMES = ["light", "dark"] as const;
const SEASONS = ["autumn", "winter", "spring", "summer"] as const;

const css = readFileSync(PAGE, "utf8");

/**
 * Every declaration of a custom property, in source order.
 *
 * The page declares each token exactly twice: once in `.cal-root` and once again inside the
 * `prefers-color-scheme: dark` block, so index 0 is the light value and index 1 the dark one.
 */
function token(name: string, theme: (typeof THEMES)[number]): string {
	const found = [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, "gu"))].map(
		(m) => m[1],
	);
	// Positive control: a token that got renamed or dropped fails here, rather than quietly making
	// every ratio below unmeasurable and therefore green.
	expect(found, `--${name} should be declared once per theme`).toHaveLength(THEMES.length);
	return found[THEMES.indexOf(theme)];
}

function channel(value: number): number {
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	return (
		0.2126 * channel(((n >> 16) & 255) / 255) +
		0.7152 * channel(((n >> 8) & 255) / 255) +
		0.0722 * channel((n & 255) / 255)
	);
}

function ratio(a: string, b: string): number {
	const [la, lb] = [luminance(a), luminance(b)];
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Every ink/surface pair the page actually renders. */
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
	["cal-ink", "cal-surface"],
	["cal-ink", "cal-recess"],
	["cal-ink", "cal-page"],
	["cal-ink", "cal-accent-tint"],
	["cal-ink", "cal-free-tint"],
	["cal-ink", "cal-fill-strong"],
	["cal-ink-2", "cal-surface"],
	["cal-ink-2", "cal-recess"],
	["cal-ink-2", "cal-page"],
	["cal-ink-2", "cal-accent-tint"],
	["cal-ink-2", "cal-free-tint"],
	["cal-accent", "cal-surface"],
	["cal-accent", "cal-page"],
	["cal-accent", "cal-free-tint"],
	["cal-accent-ink", "cal-accent"],
	["cal-free-ink", "cal-free"],
];

/**
 * Graphics that carry meaning. The lit notch is one person's day off and the accent outline is
 * today plus the selection, so both have to be discriminable.
 *
 * Deliberately absent: surface-against-surface pairs (a card on the page, a tile on the card, a
 * hairline rule) sit near 1.1:1 by design and have no WCAG floor. Nothing on this page depends on
 * seeing one; every one of them is backed by a gap, a shadow or a high-contrast mark.
 */
const GRAPHIC_PAIRS: readonly (readonly [string, string])[] = [
	["cal-seg-on", "cal-recess"],
	["cal-seg-on", "cal-seg-off"],
	["cal-accent", "cal-recess"],
	["cal-accent", "cal-surface"],
];

describe("calendar contrast", () => {
	it("knows the arithmetic, checked against pairs whose ratios are fixed", () => {
		// Black on white is 21:1 exactly, and any colour against itself is 1:1. Without this the
		// assertions below would pass just as happily on a broken ratio function.
		expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(ratio("#7a2e00", "#7a2e00")).toBeCloseTo(1, 5);
		expect(ratio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
		expect(ratio("#777777", "#ffffff")).toBeLessThan(4.5);
	});

	for (const theme of THEMES) {
		describe(theme, () => {
			it("puts every ink on every surface it lands on at AAA", () => {
				for (const [ink, surface] of TEXT_PAIRS) {
					expect(
						ratio(token(ink, theme), token(surface, theme)),
						`--${ink} on --${surface}`,
					).toBeGreaterThanOrEqual(7);
				}
			});

			it("puts the chip text at AAA on its own chip", () => {
				for (const season of SEASONS) {
					expect(
						ratio(token(`season-${season}-ink`, theme), token(`season-${season}-bg`, theme)),
						`${season} ink on ${season} bg`,
					).toBeGreaterThanOrEqual(7);
				}
			});

			it("keeps the graphics that carry meaning above the non-text bar", () => {
				for (const [mark, surface] of GRAPHIC_PAIRS) {
					expect(
						ratio(token(mark, theme), token(surface, theme)),
						`--${mark} on --${surface}`,
					).toBeGreaterThanOrEqual(3);
				}
			});

			it("keeps the day-cell season dot readable on both cell backgrounds", () => {
				for (const season of SEASONS) {
					for (const surface of ["cal-surface", "cal-recess"]) {
						expect(
							ratio(token(`season-${season}-mark`, theme), token(surface, theme)),
							`${season} mark on --${surface}`,
						).toBeGreaterThanOrEqual(4.5);
					}
				}
			});

			it("gives every season its own colour rather than four names for one", () => {
				const marks = SEASONS.map((s) => token(`season-${s}-mark`, theme));
				expect(new Set(marks).size).toBe(SEASONS.length);
			});
		});
	}
});

/** Every declaration of one property across the calendar surface, value only. */
function declarations(property: RegExp): { file: string; decl: string }[] {
	const found: { file: string; decl: string }[] = [];
	for (const file of SURFACE) {
		const source = readFileSync(file, "utf8");
		// Comments talk about borders and radii in prose; only declarations count.
		const style = source.slice(source.indexOf("<style>")).replace(/\/\*[\s\S]*?\*\//gu, "");
		for (const match of style.matchAll(property))
			found.push({ file: path.basename(file), decl: match[0].trim() });
	}
	return found;
}

describe("calendar shape and surfaces", () => {
	it("rounds every corner to the one radius token, or to a circle", () => {
		const radii = declarations(/border-radius:[^;]+;/gu);
		// Positive control: if the scrape found nothing, an empty "no offenders" list would be a
		// silent pass.
		expect(radii.length).toBeGreaterThan(10);
		const offenders = radii.filter((r) => !/border-radius:\s*(var\(--radius\)|50%);/u.test(r.decl));
		expect(offenders).toEqual([]);
	});

	it("draws no borders, only hairline rules between two surfaces", () => {
		const borders = declarations(/border(?!-radius)[a-z-]*:[^;]+;/gu);
		expect(borders.length).toBeGreaterThan(5);
		const offenders = borders.filter(
			(b) =>
				!/^border:\s*none;$/u.test(b.decl) &&
				!/^border-block-(start|end):\s*1px solid var\(--cal-rule\);$/u.test(b.decl),
		);
		expect(offenders).toEqual([]);
	});

	it("spaces everything on the 8pt grid, through the scale and nothing else", () => {
		const spacing = declarations(/(?:^|\s)(?:margin|padding|gap)[a-z-]*:[^;]+;/gu);
		expect(spacing.length).toBeGreaterThan(40);
		const offenders = spacing.filter((s) => {
			const value = s.decl.slice(s.decl.indexOf(":") + 1, -1).trim();
			// 0, auto and a 1px hairline are not spacing decisions; everything else is a token.
			return !value.split(/\s+/u).every((part) => /^(0|auto|1px|var\(--space-\d\))$/u.test(part));
		});
		expect(offenders).toEqual([]);
	});

	it("uses no physical inset, margin or padding side", () => {
		const physical = declarations(
			/(?:^|\s)(?:margin|padding|border|inset)?-?(?:top|right|bottom|left):[^;]+;/gu,
		);
		expect(physical).toEqual([]);
	});
});
