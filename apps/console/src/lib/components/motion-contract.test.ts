import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { describe, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("reduced-motion contract", () => {
	it("removes motion instead of compressing it into a near-zero duration", async () => {
		const css = await source("../../app.css");

		assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
		assert.match(css, /animation: none !important/);
		assert.match(css, /transition: none !important/);
		assert.doesNotMatch(css, /0\.001s/);
	});

	it("limits the reduced-motion exception to an explicit opacity crossfade", async () => {
		const css = await source("../../app.css");

		assert.match(
			css,
			/\.reduced-motion-opacity-crossfade\s*{\s*transition: opacity var\(--dur-fast\) linear !important/,
		);
	});
});

describe("shared component motion", () => {
	it("uses the fast token for StatusPill state feedback", async () => {
		const pill = await source("./StatusPill.svelte");

		assert.match(pill, /if \(nextState === previousState\) return/);
		assert.match(pill, /class:flipping/);
		assert.match(pill, /animation: flip var\(--dur-fast\) var\(--ease-standard\) both/);
	});

	it("offers tokenized, opt-in Panel staggering", async () => {
		const [css, panel] = await Promise.all([source("../../app.css"), source("./Panel.svelte")]);

		assert.match(css, /--dur-stagger: 24ms/);
		assert.match(panel, /settleIndex\?: number \| null/);
		assert.match(
			panel,
			/animation-delay: calc\(var\(--panel-settle-index\) \* var\(--dur-stagger\)\)/,
		);
	});
});
