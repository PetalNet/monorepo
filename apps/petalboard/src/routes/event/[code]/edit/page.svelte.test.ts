// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import type { PageData } from "./$types";
import Page from "./+page.svelte";

let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

function render(form: { expired: true } | null = null) {
	const target = document.createElement("div");
	const data: PageData = {
		user: null,
		token: "tok",
		event: {
			title: "Friendsgiving",
			publicCode: "CODE1234",
			emoji: "🦃",
			primaryColor: "amber",
			secondaryColor: "orange",
			backgroundImage: null,
		},
	};

	document.body.append(target);
	const component = mount(Page, { target, props: { data, form } });

	cleanup = () => {
		void unmount(component);
		target.remove();
	};
	flushSync();

	return target;
}

describe("edit link page", () => {
	it("wears the event's theme, like the event page", () => {
		const target = render();
		const root = document.documentElement;
		const button = target.querySelector<HTMLButtonElement>('button[type="submit"]');

		expect(root.getAttribute("data-event-title")).toBe("Friendsgiving");
		expect(root.style.getPropertyValue("--event-primary-600")).toBe("#d97706");
		expect(button?.textContent).toBe("Continue");
		expect(button?.getAttribute("style")).toContain("linear-gradient(135deg, #b45309, #c2410c)");
		expect(button?.classList.contains("min-h-11")).toBe(true);

		cleanup?.();
		cleanup = undefined;

		expect(root.hasAttribute("data-event-page")).toBe(false);
	});

	it("keeps the theme on the expired-link answer", () => {
		const target = render({ expired: true });

		expect(target.querySelector('[role="alert"]')?.textContent).toContain("expired");
		expect(document.documentElement.getAttribute("data-event-page")).toBe("true");
	});
});
