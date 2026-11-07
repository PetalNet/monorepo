import { describe, expect, it } from "vitest";

import { setFileMode } from "./file-view.ts";
import { createDiff } from "./view.ts";

describe("file preview toggle", () => {
	it("defaults to preview and restores GitHub's code view", () => {
		document.body.innerHTML = `
			<ul aria-label="File view">
				<li data-gh-plantuml="preview-item"><button aria-pressed="true"></button></li>
				<li data-selected><button aria-pressed="true" style="--separator-color: transparent"></button></li>
			</ul>
			<section aria-labelledby="file-name-id"><div id="code">source</div><div id="preview"></div></section>`;

		const section = document.querySelector<HTMLElement>("section");
		const preview = document.querySelector<HTMLElement>("#preview");

		if (section === null || preview === null) {
			throw new Error("fixture is incomplete");
		}

		setFileMode(section, preview, "preview");
		expect(document.querySelector<HTMLElement>("#code")?.hidden).toBe(true);
		expect(preview.hidden).toBe(false);

		expect(
			document.querySelector<HTMLElement>("li:not([data-gh-plantuml])")?.dataset["selected"],
		).toBeUndefined();

		setFileMode(section, preview, "code");
		expect(document.querySelector<HTMLElement>("#code")?.hidden).toBe(false);
		expect(preview.hidden).toBe(true);

		expect(
			document
				.querySelector<HTMLButtonElement>("li:not([data-gh-plantuml]) button")
				?.getAttribute("aria-pressed"),
		).toBe("true");

		expect(
			document.querySelector<HTMLElement>("li:not([data-gh-plantuml])")?.dataset["selected"],
		).toBe("");
	});
});

describe("rich diff", () => {
	it("switches swipe and onion modes and exposes their controls", () => {
		const diff = createDiff("before", "after");

		document.body.replaceChildren(diff);

		const choose = (mode: string) => {
			diff.querySelector<HTMLInputElement>(`input[value="${mode}"]`)?.click();
		};

		expect(diff.querySelector<HTMLElement>(".two-up")?.hidden).toBe(false);
		choose("swipe");
		expect(diff.querySelector<HTMLElement>(".swipe")?.hidden).toBe(false);
		expect(diff.querySelector<HTMLElement>(".two-up")?.hidden).toBe(true);
		expect(diff.querySelector<HTMLElement>(".swipe-bar")).not.toBeNull();
		choose("onion-skin");
		expect(diff.querySelector<HTMLElement>(".onion-skin")?.hidden).toBe(false);
		expect(diff.querySelector<HTMLElement>(".swipe")?.hidden).toBe(true);
	});
});
