import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("modal surface contract", () => {
	it("defines explicit dialog and drawer variants with the shared material vocabulary", async () => {
		const modal = await source("./ModalSurface.svelte");
		expect(modal).toMatch(/variant: "dialog" \| "drawer"/);
		expect(modal).toMatch(/box-shadow:var\(--shadow-pop\)/);
		expect(modal).toMatch(/border-radius:var\(--r-lg\)/);
		expect(modal).toMatch(/::backdrop/);
		expect(modal).toMatch(/dialog-close/);
		expect(modal).toMatch(/:not\(\[open\]\)\{display:none\}/);
	});

	it("captures and restores focus around the native modal lifecycle", async () => {
		const modal = await source("./ModalSurface.svelte");
		expect(modal).toMatch(/focusOrigin = document\.activeElement/);
		expect(modal).toMatch(/element\.showModal\(\)/);
		expect(modal).toMatch(/queueMicrotask\(\(\) => origin\?\.focus\(\)\)/);
	});

	it("migrates each audited route to the shared variants", async () => {
		const routes = await Promise.all(
			["cost", "terminal", "observability", "work", "library"].map((route) =>
				source(`../../routes/${route}/+page.svelte`),
			),
		);
		for (const route of routes) expect(route).toMatch(/<ModalSurface/);
		expect(routes.filter((route) => /variant="drawer"/.test(route)).length).toBe(3);
	});
});
