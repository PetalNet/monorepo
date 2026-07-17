import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("modal surface contract", () => {
	it("defines explicit dialog and drawer variants with the shared material vocabulary", async () => {
		const modal = await source("./ModalSurface.svelte");
		assert.match(modal, /variant: "dialog" \| "drawer"/);
		assert.match(modal, /box-shadow:var\(--shadow-pop\)/);
		assert.match(modal, /border-radius:var\(--r-lg\)/);
		assert.match(modal, /::backdrop/);
		assert.match(modal, /dialog-close/);
		assert.match(modal, /:not\(\[open\]\)\{display:none\}/);
	});

	it("captures and restores focus around the native modal lifecycle", async () => {
		const modal = await source("./ModalSurface.svelte");
		assert.match(modal, /focusOrigin = document\.activeElement/);
		assert.match(modal, /element\.showModal\(\)/);
		assert.match(modal, /queueMicrotask\(\(\) => origin\?\.focus\(\)\)/);
	});

	it("migrates each audited route to the shared variants", async () => {
		const routes = await Promise.all(
			["cost", "terminal", "observability", "work", "library"].map((route) =>
				source(`../../routes/${route}/+page.svelte`),
			),
		);
		for (const route of routes) assert.match(route, /<ModalSurface/);
		assert.equal(routes.filter((route) => /variant="drawer"/.test(route)).length, 2);
	});
});
