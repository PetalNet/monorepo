// @vitest-environment happy-dom
import type { PotluckCategory } from "$lib/potluck";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import PotluckCategoryChips from "./PotluckCategoryChips.svelte";

const category: PotluckCategory = {
	id: "desserts",
	label: "Desserts",
	ratio: 1,
	ideas: [],
	forceOpen: false,
};

let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

describe("PotluckCategoryChips", () => {
	it("labels closed categories as full instead of showing their count", () => {
		const target = document.createElement("div");

		document.body.append(target);

		const component = mount(PotluckCategoryChips, {
			target,
			props: {
				questionId: "q1",
				categories: [{ category, offered: false }],
				selected: "",
				counts: { desserts: 2 },
				required: false,
				optedOut: false,
				onchoose: vi.fn(),
				onskip: vi.fn(),
			},
		});

		cleanup = () => {
			void unmount(component);
			target.remove();
		};

		flushSync();

		const tile = target.querySelector(".potluck-choice.closed");

		expect(tile?.textContent).toContain("Full");
		expect(tile?.textContent).not.toContain("2");
	});
});
