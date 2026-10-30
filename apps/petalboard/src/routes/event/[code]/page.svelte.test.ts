// @vitest-environment happy-dom
import type { SubmitFunction } from "@sveltejs/kit";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionData, PageData } from "./$types";
import Page from "./+page.svelte";

const submitters = new Map<string, SubmitFunction>();

vi.mock("$app/forms", () => ({
	enhance: (form: HTMLFormElement, submit: SubmitFunction) => {
		submitters.set(form.getAttribute("action") ?? "", submit);

		return { destroy: () => submitters.delete(form.getAttribute("action") ?? "") };
	},
}));

vi.mock("$app/navigation", () => ({ invalidateAll: async () => undefined }));

vi.mock("$env/dynamic/public", () => ({ env: {} }));

type Rsvp = PageData["rsvps"][number];
type Question = PageData["event"]["questions"][number];

const guestNames = [
	"Avery",
	"Blake",
	"Casey",
	"Drew",
	"Emery",
	"Finley",
	"Harper",
	"Jules",
	"Kai",
	"Lena",
];

function rsvp(name: string, status: string): Rsvp {
	return {
		id: `rsvp-${name}`,
		name,
		email: null,
		status,
		guestCount: 1,
		createdAt: new Date("2026-10-01T12:00:00Z"),
		responses: [],
	};
}

function songsQuestion(): Question {
	return {
		id: "songs",
		label: "Add some music",
		description: null,
		type: "spotify_playlist",
		options: null,
		quantity: null,
		required: false,
		isPublic: true,
		spotifyPlaylistId: null,
		songsPerUser: null,
		responseCount: guestNames.length,
		potluck: null,
		publicResponses: guestNames.map((name, i) => ({
			name,
			status: "attending",
			value: JSON.stringify([{ id: `t${i}`, name: `Song ${i}`, artists: [{ name: "Band" }] }]),
		})),
	};
}

function pageData(): PageData {
	const rsvps = [
		...guestNames.map((name) => rsvp(name, "attending")),
		rsvp("Morgan", "not_attending"),
	];

	return {
		user: null,
		isOwner: false,
		event: {
			id: "event-1",
			title: "Friendsgiving",
			description: null,
			date: new Date("2026-11-28T23:00:00Z"),
			endDate: null,
			timezone: "America/Chicago",
			location: null,
			publicCode: "CODE1234",
			rsvpLimit: null,
			rsvpCount: rsvps.length,
			totalGuests: rsvps.length,
			theme: "light",
			primaryColor: "amber",
			secondaryColor: "amber",
			backgroundImage: null,
			emoji: null,
			questions: [songsQuestion()],
		},
		rsvps,
	};
}

let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	submitters.clear();
});

function render(form: ActionData | null = null): HTMLElement {
	const target = document.createElement("div");

	document.body.append(target);
	const component = mount(Page, { target, props: { data: pageData(), form } });

	cleanup = () => {
		void unmount(component);
		target.remove();
	};

	flushSync();

	return target;
}

function button(root: ParentNode, text: string): HTMLButtonElement {
	const found = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text);

	if (!found) {
		throw new Error(`no "${text}" button`);
	}

	return found;
}

function pressEscape(on: Element) {
	on.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
	);

	flushSync();
}

describe("event page dialogs", () => {
	it("closes the RSVP dialog on Escape pressed inside the form", () => {
		const target = render();

		button(target, "RSVP Now").click();
		flushSync();
		const nameInput = target.querySelector('[role="dialog"] input[name="name"]');

		expect(nameInput).not.toBeNull();
		pressEscape(nameInput!);

		expect(target.querySelector('[role="dialog"]')).toBeNull();
	});

	it("closes the edit-RSVP dialog on Escape pressed inside the form", () => {
		const target = render({
			type: "lookupRsvp",
			success: true,
			rsvp: {
				id: "rsvp-Avery",
				name: "Avery",
				email: null,
				status: "attending",
				guestCount: 1,
				responses: {},
			},
		});
		const nameInput = target.querySelector(
			'[aria-labelledby="edit-rsvp-title"] input[name="name"]',
		);

		expect(nameInput).not.toBeNull();
		pressEscape(nameInput!);

		expect(target.querySelector("#edit-rsvp-title")).toBeNull();
	});

	it("locks Confirm RSVP and shows Saving while the RSVP submits", async () => {
		const target = render();

		button(target, "RSVP Now").click();
		flushSync();
		const form = target.querySelector<HTMLFormElement>('form[action="?/rsvp"]');
		const submit = submitters.get("?/rsvp");

		if (!form || !submit) {
			throw new Error("RSVP form did not mount");
		}

		const action = new URL("http://localhost/event/CODE1234?/rsvp");
		const after = await submit({
			action,
			formData: new FormData(form),
			formElement: form,
			controller: new AbortController(),
			submitter: null,
			cancel: () => undefined,
		});

		flushSync();
		const saving = button(target, "Saving…");

		expect(saving.disabled).toBe(true);

		if (typeof after !== "function") {
			throw new TypeError("enhance callback did not return a result handler");
		}

		await after({
			action,
			formData: new FormData(form),
			formElement: form,
			result: { type: "failure", status: 400, data: { type: "rsvp", message: "Try again" } },
			update: async () => undefined,
		});

		flushSync();

		expect(button(target, "Confirm RSVP").disabled).toBe(false);
	});

	it("labels every pencil and close button for screen readers", () => {
		const target = render();
		const pencils = [...target.querySelectorAll("button")].filter((b) =>
			b.textContent.includes("✏️"),
		);

		expect(pencils.length).toBeGreaterThan(0);

		expect(pencils.map((b) => b.getAttribute("aria-label"))).toEqual(
			pencils.map(
				(b) =>
					`Edit ${b.closest(".panel-list-item")?.querySelector("strong")?.textContent.trim()}'s RSVP`,
			),
		);

		button(target, "RSVP Now").click();
		flushSync();

		expect(target.querySelector('[role="dialog"] .close-btn')?.getAttribute("aria-label")).toBe(
			"Close",
		);
	});
});

describe("event page dialog dismissal", () => {
	it("keeps the RSVP dialog open for clicks and Space inside it", () => {
		const target = render();

		button(target, "RSVP Now").click();
		flushSync();
		const dialog = target.querySelector('[role="dialog"]');
		const nameInput = dialog?.querySelector('input[name="name"]');

		if (!dialog || !nameInput) {
			throw new Error("RSVP dialog did not open");
		}

		dialog.querySelector("h3")?.click();

		nameInput.dispatchEvent(
			new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
		);

		nameInput.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		);

		flushSync();

		expect(target.querySelector('[role="dialog"]')).toBe(dialog);
	});

	it("closes the RSVP dialog when the backdrop itself is clicked", () => {
		const target = render();

		button(target, "RSVP Now").click();
		flushSync();
		target.querySelector<HTMLElement>(".modal-backdrop")?.click();
		flushSync();

		expect(target.querySelector('[role="dialog"]')).toBeNull();
	});

	it("lets Escape in the song search close only the results, not the RSVP", async () => {
		vi.useFakeTimers();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					tracks: {
						items: [
							{
								id: "f1",
								name: "Found Song",
								uri: "spotify:track:f1",
								artists: [{ name: "Band" }],
								album: { name: "Album", images: [] },
							},
						],
					},
				}),
			),
		);

		try {
			const target = render();

			button(target, "RSVP Now").click();
			flushSync();

			const search = target.querySelector<HTMLInputElement>(
				'[role="dialog"] input[placeholder^="Search for a song"]',
			);

			if (!search) {
				throw new Error("no song search");
			}

			search.value = "found";
			search.dispatchEvent(new Event("input", { bubbles: true }));
			await vi.advanceTimersByTimeAsync(400);
			flushSync();

			expect(target.textContent).toContain("Found Song");
			pressEscape(search);

			expect(target.querySelector('[role="dialog"]')).not.toBeNull();
			expect(target.textContent).not.toContain("Found Song");
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});
});

describe("event page lists", () => {
	it("shows the first 8 guests until Show all is pressed, then focuses the first revealed guest", async () => {
		const target = render();
		const panel = target.querySelector("details.tone-attending");

		if (!panel) {
			throw new Error("no attending panel");
		}

		expect(panel.querySelectorAll(".panel-list-item")).toHaveLength(8);
		button(panel, `Show all ${guestNames.length}`).click();
		await tick();
		await tick();

		expect(panel.querySelectorAll(".panel-list-item")).toHaveLength(guestNames.length);
		expect(document.activeElement).toBe(panel.querySelectorAll(".panel-list-item button")[8]);

		expect(
			[...panel.querySelectorAll("button")].some((b) => b.textContent.startsWith("Show all")),
		).toBe(false);
	});

	it("labels the song list as songs and shows the first 8 until Show all, then focuses the first revealed song", async () => {
		const target = render();
		const block = target.querySelector(".panel-block.tone-attending");

		if (!block) {
			throw new Error("no song list");
		}

		expect(block.querySelector("h3")?.textContent.replaceAll(/\s+/g, " ").trim()).toBe(
			`✓ Attending (${guestNames.length} songs)`,
		);

		expect(block.querySelectorAll("li")).toHaveLength(8);
		button(block, `Show all ${guestNames.length}`).click();
		await tick();
		await tick();

		expect(block.querySelectorAll("li")).toHaveLength(guestNames.length);
		expect(document.activeElement).toBe(block.querySelectorAll("li")[8]);
	});
});

describe("event page banners", () => {
	it.each([
		[{ type: "rsvp", success: true, rsvpId: "rsvp-new" }, "✅ You're all set!"],
		[{ type: "updateRsvp", success: true, message: "Updated" }, "✅ Updated!"],
		[{ type: "cancelRsvp", success: true, message: "Cancelled" }, "RSVP Cancelled"],
	])("tints the whole %o banner instead of a left stripe", (form, title) => {
		const target = render(form as ActionData);
		const heading = [...target.querySelectorAll("h2")].find((h) => h.textContent.trim() === title);
		const banner = heading?.closest<HTMLElement>("[style*='background-color']");

		expect(banner?.style.backgroundColor).toBeTruthy();

		expect(
			["Top", "Right", "Bottom", "Left"].map((side) =>
				banner?.style.getPropertyValue(`border-${side.toLowerCase()}-width`),
			),
		).toEqual(["1px", "1px", "1px", "1px"]);
	});
});
