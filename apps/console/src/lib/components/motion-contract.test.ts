import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("reduced-motion contract", () => {
	it("removes motion instead of compressing it into a near-zero duration", async () => {
		const css = await source("../../app.css");

		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
		expect(css).toMatch(/animation: none !important/);
		expect(css).toMatch(/transition: none !important/);
		expect(css).not.toMatch(/0\.001s/);
	});

	it("limits the reduced-motion exception to an explicit opacity crossfade", async () => {
		const css = await source("../../app.css");

		expect(css).toMatch(
			/\.reduced-motion-opacity-crossfade\s*{\s*transition: opacity var\(--dur-fast\) linear !important/,
		);
	});
});

describe("shared component motion", () => {
	it("uses the fast token for StatusPill state feedback", async () => {
		const pill = await source("./StatusPill.svelte");

		expect(pill).toMatch(/if \(nextState === previousState\) return/);
		expect(pill).toMatch(/class:flipping/);
		expect(pill).toMatch(/animation: flip var\(--dur-fast\) var\(--ease-standard\) both/);
	});

	it("offers tokenized, opt-in Panel staggering", async () => {
		const [css, panel] = await Promise.all([source("../../app.css"), source("./Panel.svelte")]);

		expect(css).toMatch(/--dur-stagger: 24ms/);
		expect(panel).toMatch(/settleIndex\?: number \| null/);
		expect(panel).toMatch(
			/animation-delay: calc\(var\(--panel-settle-index\) \* var\(--dur-stagger\)\)/,
		);
	});
});
