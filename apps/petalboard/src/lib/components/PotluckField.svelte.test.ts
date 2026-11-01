// @vitest-environment happy-dom
import { FRIENDSGIVING_POTLUCK, type PotluckView } from "$lib/potluck";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PotluckField from "./PotluckField.svelte";

const view: PotluckView = {
	config: FRIENDSGIVING_POTLUCK,
	counts: { desserts: 1 },
	taken: [{ category: "desserts", dish: "pie", name: null }],
};

let cleanup: (() => void) | undefined;

beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: true }));
});

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	vi.unstubAllGlobals();
});

function render(required = false, value = "") {
	const form = document.createElement("form");
	const target = document.createElement("div");
	let latest = value;

	form.append(target);
	document.body.append(form);

	const component = mount(PotluckField, {
		target,
		props: {
			questionId: "q1",
			label: "What dish will you be bringing?",
			required,
			view,
			value,
			onchange: (raw: string) => (latest = raw),
		},
	});

	cleanup = () => {
		void unmount(component);
		form.remove();
	};

	flushSync();

	return {
		form,
		target,
		dish: () => target.querySelector<HTMLInputElement>('input[type="text"]'),
		hidden: () => target.querySelector<HTMLInputElement>('input[name="response_q1"]')?.value,
		latest: () => latest,
		radio: (radioValue: string) =>
			target.querySelector<HTMLInputElement>(`input[type="radio"][value="${radioValue}"]`),
	};
}

describe("PotluckField", () => {
	it("uses a labelled native radiogroup and keeps the dish hidden before a choice", () => {
		const field = render();

		expect(field.target.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
			"What dish will you be bringing?",
		);

		expect(field.radio("sides")).not.toBeNull();
		expect(field.dish()).toBeNull();
		expect(field.target.querySelectorAll("button")).toHaveLength(0);
	});

	it("reveals and focuses the dish input after a category is picked", async () => {
		const field = render();

		field.radio("sides")?.click();
		await tick();
		flushSync();

		expect(field.dish()).toBe(document.activeElement);
		expect(field.dish()?.placeholder).toBe("e.g. mashed potatoes, hash-brown casserole");
		expect(field.hidden()).toBe("");
	});

	it("keeps a typed dish when the category changes", async () => {
		const field = render();

		field.radio("sides")?.click();
		await tick();
		const dish = field.dish();

		if (!dish) {
			throw new Error("dish input missing");
		}

		dish.value = "stuffing";
		dish.dispatchEvent(new Event("input"));
		flushSync();
		field.radio("drinks")?.click();
		await tick();
		flushSync();

		expect(field.dish()?.value).toBe("stuffing");
		expect(field.latest()).toBe(JSON.stringify({ category: "drinks", dish: "stuffing" }));
	});

	it("updates the compact category counts with the in-progress choice", async () => {
		const field = render();
		const count = (value: string) => field.radio(value)?.closest("label")?.querySelector("small");

		expect(count("sides")?.textContent).toBe("0");
		field.radio("sides")?.click();
		await tick();
		flushSync();
		expect(count("sides")?.textContent).toBe("1");
		field.radio("drinks")?.click();
		await tick();
		flushSync();
		expect(count("sides")?.textContent).toBe("0");
		expect(count("drinks")?.textContent).toBe("1");
	});

	it("lets an optional RSVP withdraw a dish", () => {
		const field = render(false, JSON.stringify({ category: "sides", dish: "stuffing" }));

		field.radio("")?.click();
		flushSync();

		expect(field.hidden()).toBe("");
		expect(field.latest()).toBe("");
		expect(field.dish()).toBeNull();
	});

	it("does not offer an opt-out for a required question", () => {
		const field = render(true);

		expect(field.radio("")).toBeNull();
		expect(field.form.checkValidity()).toBe(false);

		expect(field.target.querySelector<HTMLInputElement>('input[type="radio"]')?.required).toBe(
			true,
		);
	});
});
