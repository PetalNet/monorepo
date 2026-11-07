// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PlusOnesField, { newPerson, type Person } from "./PlusOnesField.svelte";

let cleanup: (() => void) | undefined;

beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: true }));
});

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	vi.unstubAllGlobals();
});

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | null {
	return (
		[...root.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === text,
		) ?? null
	);
}

function render(people: Person[], maxPlusOnes: number | null): HTMLElement {
	const target = document.createElement("div");

	document.body.append(target);

	const component = mount(PlusOnesField, {
		target,
		props: { people, maxPlusOnes },
	});

	cleanup = () => {
		void unmount(component);
		target.remove();
	};

	flushSync();

	return target;
}

describe("PlusOnesField", () => {
	it("removes the add button at the cap and restores it after a removal without cap copy", async () => {
		const people = $state<Person[]>([newPerson("Sam")]);
		const target = render(people, 2);
		const add = buttonByText(target, "Add a person");

		expect(add).not.toBeNull();
		add?.click();
		await tick();
		flushSync();

		expect(buttonByText(target, "Add a person")).toBeNull();
		expect(target.textContent).not.toMatch(/most we can fit|people including you|just you so far/i);

		target.querySelector<HTMLButtonElement>('button[aria-label="Remove person 2"]')?.click();
		await tick();
		flushSync();

		expect(buttonByText(target, "Add a person")).not.toBeNull();
	});

	it("keeps existing people visible at a zero cap without an add button", () => {
		const people = $state<Person[]>([newPerson("Sam"), newPerson("Alex")]);
		const target = render(people, 0);

		expect(buttonByText(target, "Add a person")).toBeNull();
		expect(target.querySelectorAll(".plus-ones-row")).toHaveLength(2);
	});

	it("does not render the plus-one group at a zero cap without people", () => {
		const people = $state<Person[]>([]);
		const target = render(people, 0);

		expect(target.textContent).not.toContain("Bringing anyone?");
	});
});
