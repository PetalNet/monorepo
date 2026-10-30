// @vitest-environment happy-dom
import { FRIENDSGIVING_POTLUCK, type PotluckView } from "$lib/potluck";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import PotluckField from "./PotluckField.svelte";

const view: PotluckView = {
	config: FRIENDSGIVING_POTLUCK,
	counts: { desserts: 1 },
	taken: [{ category: "desserts", dish: "pie", name: null }],
};

let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

function render(required: boolean, value: string) {
	const target = document.createElement("div");
	let latest = value;

	document.body.append(target);

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
		target.remove();
	};

	flushSync();

	const optOut = [...target.querySelectorAll("label")].find(
		(l) => l.textContent.trim() === "Not bringing a dish",
	);

	return {
		optOut,
		hidden: () => target.querySelector<HTMLInputElement>('input[name="response_q1"]')?.value,
		dish: () => target.querySelector<HTMLInputElement>('input[type="text"]'),
		latest: () => latest,
	};
}

describe("PotluckField", () => {
	it("lets a guest withdraw a dish from an optional question", () => {
		const field = render(false, JSON.stringify({ category: "sides", dish: "stuffing" }));

		expect(field.hidden()).toBe(JSON.stringify({ category: "sides", dish: "stuffing" }));
		expect(field.optOut).toBeDefined();
		field.optOut?.querySelector("input")?.click();
		flushSync();

		expect(field.hidden()).toBe("");
		expect(field.latest()).toBe("");
		expect(field.dish()).toBeNull();
	});

	it("does not mark the opt-out when no category is picked yet", () => {
		const field = render(false, "");

		expect(field.optOut?.querySelector("input")?.checked).toBe(false);
		expect(field.dish()?.checkValidity()).toBe(true);
	});

	it("blocks a typed dish that has no category, so it is never silently dropped", () => {
		const field = render(false, "");
		const input = field.dish();

		if (!input) {
			throw new Error("dish input missing");
		}

		input.value = "cornbread";
		input.dispatchEvent(new Event("input"));
		flushSync();

		expect(input.checkValidity()).toBe(false);
		expect(field.hidden()).toBe("");
	});

	it("offers no opt-out when the host made the question required", () => {
		expect(render(true, "").optOut).toBeUndefined();
	});
});
