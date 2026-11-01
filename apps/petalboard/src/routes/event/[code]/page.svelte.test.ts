// @vitest-environment happy-dom
import type { SubmitFunction } from "@sveltejs/kit";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionData, PageData } from "./$types";
import Page from "./+page.svelte";

const submitters = new Map<string, SubmitFunction>();

Object.defineProperties(HTMLDialogElement.prototype, {
	showModal: {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.setAttribute("open", "");
		},
	},
	close: {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.removeAttribute("open");
			this.dispatchEvent(new Event("close"));
		},
	},
});

vi.mock("$app/forms", () => ({
	enhance: (form: HTMLFormElement, submit: SubmitFunction) => {
		submitters.set(form.getAttribute("action") ?? "", submit);

		return { destroy: () => submitters.delete(form.getAttribute("action") ?? "") };
	},
}));

vi.mock("$app/navigation", () => ({
	invalidateAll: async () => undefined,
	replaceState: (url: URL) => {
		window.history.replaceState({}, "", url);
	},
}));

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
		guestNames: [],
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

const potluckQuestion: Question = {
	id: "potluck",
	label: "Potluck",
	description: null,
	type: "potluck",
	options: null,
	quantity: null,
	required: false,
	isPublic: true,
	spotifyPlaylistId: null,
	songsPerUser: null,
	responseCount: 0,
	potluck: {
		config: {
			providing: "Main dish",
			minOptions: 2,
			categories: [
				{ id: "sides", label: "Sides", ratio: 1, ideas: [], forceOpen: false },
				{ id: "desserts", label: "Desserts", ratio: 1, ideas: [], forceOpen: false },
			],
		},
		counts: {},
		taken: [],
	},
	publicResponses: [],
};

const avery: NonNullable<PageData["myRsvp"]> = {
	id: "rsvp-Avery",
	name: "Avery",
	email: "avery@example.test",
	status: "attending",
	guestCount: 1,
	guestNames: [],
	responses: {},
};

function pageData(
	myRsvp: PageData["myRsvp"] = null,
	questions: Question[] = [songsQuestion()],
): PageData {
	const rsvps = [
		...guestNames.map((name) => rsvp(name, "attending")),
		rsvp("Morgan", "not_attending"),
	];

	return {
		user: null,
		isOwner: false,
		myRsvp,
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
			maxPlusOnes: null,
			rsvpCount: rsvps.length,
			totalGuests: rsvps.length,
			theme: "light",
			primaryColor: "amber",
			secondaryColor: "amber",
			backgroundImage: null,
			emoji: null,
			questions,
		},
		rsvps,
	};
}

let cleanup: (() => void) | undefined;

afterEach(() => {
	window.history.replaceState({}, "", "/");
	cleanup?.();
	cleanup = undefined;
	submitters.clear();
});

function render(
	form: ActionData | null = null,
	myRsvp: PageData["myRsvp"] = null,
	questions: Question[] = [songsQuestion()],
): HTMLElement {
	const target = document.createElement("div");

	document.body.append(target);
	const component = mount(Page, { target, props: { data: pageData(myRsvp, questions), form } });

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

describe("event page dialogs", () => {
	it("opens the RSVP dialog natively", () => {
		const target = render();

		button(target, "RSVP").click();
		flushSync();

		const dialog = target.querySelector<HTMLDialogElement>(
			'dialog[open][aria-labelledby="create-rsvp-title"]',
		);

		expect(dialog?.querySelector('input[name="name"]')).not.toBeNull();
	});

	it("closes the edit-RSVP dialog on Escape pressed inside the form", () => {
		const target = render(null, avery);

		button(target, "Edit my RSVP").click();
		flushSync();

		const nameInput = target.querySelector<HTMLInputElement>(
			'[aria-labelledby="edit-rsvp-title"] input[name="name"]',
		);

		expect(nameInput?.value).toBe("Avery");
		expect(nameInput?.closest("dialog")?.hasAttribute("open")).toBe(true);
	});

	it("opens my RSVP for editing when an edit link lands on ?edit=1, focused, and drops the param", async () => {
		window.history.replaceState({}, "", "/event/CODE1234?edit=1&ref=mail");
		const target = render(null, avery);

		await tick();
		await tick();

		const nameInput = target.querySelector<HTMLInputElement>(
			'[aria-labelledby="edit-rsvp-title"] input[name="name"]',
		);

		expect(nameInput?.value).toBe("Avery");
		expect(document.activeElement).toBe(nameInput);
		expect(target.textContent).toContain("avery@example.test");
		expect(window.location.pathname + window.location.search).toBe("/event/CODE1234?ref=mail");
	});

	it("moves focus into the edit dialog when Edit my RSVP opens it", async () => {
		const target = render(null, avery);

		button(target, "Edit my RSVP").click();
		await tick();

		expect(document.activeElement).toBe(
			target.querySelector('[aria-labelledby="edit-rsvp-title"] input[name="name"]'),
		);
	});

	it("submits the shown RSVP's id with update and cancel", () => {
		const target = render(null, avery);

		button(target, "Edit my RSVP").click();
		flushSync();

		for (const action of ["?/updateRsvp", "?/cancelRsvp"]) {
			const form = target.querySelector<HTMLFormElement>(`form[action="${action}"]`);

			expect(new FormData(form!).get("expectedRsvpId")).toBe("rsvp-Avery");
		}
	});

	async function openLinkDialog() {
		const target = render();

		button(target, "Edit my RSVP").click();
		await tick();
		const dialog = target.querySelector('dialog[open][aria-labelledby="edit-link-title"]');
		const email = dialog?.querySelector<HTMLInputElement>('input[name="email"]');
		const form = dialog?.querySelector<HTMLFormElement>('form[action="?/requestEditLink"]');
		const submit = submitters.get("?/requestEditLink");

		if (!dialog || !email || !form || !submit) {
			throw new Error("edit link dialog did not open");
		}

		const action = new URL("http://localhost/event/CODE1234?/requestEditLink");
		const send = async () => {
			const after = await submit({
				action,
				formData: new FormData(form),
				formElement: form,
				controller: new AbortController(),
				submitter: null,
				cancel: () => undefined,
			});

			flushSync();

			if (typeof after !== "function") {
				throw new TypeError("enhance callback did not return a result handler");
			}

			return async (result: Parameters<typeof after>[0]["result"]) => {
				await after({
					action,
					formData: new FormData(form),
					formElement: form,
					result,
					update: async () => undefined,
				});

				flushSync();
			};
		};

		return { target, dialog, email, send };
	}

	it("emails an edit link from a labelled, focused email field and shows the server's answer", async () => {
		const { dialog, email, send } = await openLinkDialog();

		expect(email.closest("label")?.textContent).toContain("The email you RSVP'd with");
		expect(document.activeElement).toBe(email);

		const finish = await send();

		expect(button(dialog, "Sending…").disabled).toBe(true);

		await finish({
			type: "success",
			status: 200,
			data: { type: "requestEditLink", success: true, message: "Check your inbox." },
		});

		const status = dialog.querySelector('[role="status"]');

		expect(status?.textContent).toBe("Check your inbox.");
		expect(document.activeElement).toBe(status);
		expect(dialog.querySelector("form")).toBeNull();
	});

	it("says so when sending the edit link errors, and lets the guest try again", async () => {
		const { dialog, send } = await openLinkDialog();
		const finish = await send();

		await finish({ type: "error", status: 500, error: new Error("boom") });

		expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
			"Something went wrong sending your link. Try again in a minute.",
		);

		expect(button(dialog, "Email me a link").disabled).toBe(false);
	});

	it("locks Confirm RSVP and shows Saving while the RSVP submits", async () => {
		const target = render();

		button(target, "RSVP").click();
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
			result: {
				type: "failure",
				status: 400,
				data: { type: "rsvp", message: "Try again", guestNames: ["Sam", "Alex"] },
			},
			update: async () => undefined,
		});

		flushSync();

		expect(button(target, "Confirm RSVP").disabled).toBe(false);

		expect(
			[...target.querySelectorAll<HTMLInputElement>('input[name="guestName"]')].map(
				(input) => input.value,
			),
		).toEqual(["Sam", "Alex"]);
	});

	it("rehydrates people after a failed non-enhanced RSVP", () => {
		const target = render({
			type: "rsvp",
			success: false,
			values: { name: "Avery", email: "avery@example.test" },
			errors: { guestNames: ["Give each person you add a name, or remove them"] },
			guestNames: ["Sam", ""],
		});

		expect(target.querySelector('[aria-labelledby="create-rsvp-title"]')).not.toBeNull();

		expect(
			[...target.querySelectorAll<HTMLInputElement>('input[name="guestName"]')].map(
				(input) => input.value,
			),
		).toEqual(["Sam", ""]);
	});

	it("shows a labelled pencil only on this browser's own RSVP", () => {
		const pencils = (root: ParentNode) =>
			[...root.querySelectorAll("button")].filter((b) => b.textContent.includes("✏️"));

		expect(pencils(render())).toEqual([]);
		cleanup?.();

		const target = render(null, avery);
		const own = pencils(target);

		expect(own.map((b) => b.getAttribute("aria-label"))).toEqual(["Edit my RSVP"]);

		expect(own[0].closest(".panel-list-item")?.querySelector("strong")?.textContent.trim()).toBe(
			"Avery",
		);

		button(target, "Edit my RSVP").click();
		flushSync();

		expect(target.querySelector("dialog[open] .close-btn")?.getAttribute("aria-label")).toBe(
			"Close",
		);
	});
});

describe("event page dialog dismissal", () => {
	it("closes the RSVP dialog when its backdrop is clicked", () => {
		const target = render();

		button(target, "RSVP").click();
		flushSync();
		target.querySelector<HTMLDialogElement>("dialog")?.click();
		flushSync();

		expect(target.querySelector("dialog")).toBeNull();
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

			button(target, "RSVP").click();
			flushSync();

			const search = target.querySelector<HTMLInputElement>(
				'dialog[open] input[placeholder^="Search for a song"]',
			);

			if (!search) {
				throw new Error("no song search");
			}

			search.value = "found";
			search.dispatchEvent(new Event("input", { bubbles: true }));
			await vi.advanceTimersByTimeAsync(400);
			flushSync();

			expect(target.textContent).toContain("Found Song");
			search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			flushSync();

			expect(target.querySelector("dialog[open]")).not.toBeNull();
			expect(target.textContent).not.toContain("Found Song");
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});
});

describe("event page lists", () => {
	it("labels host-provided potluck food on the page and RSVP form", () => {
		const target = render(null, null, [potluckQuestion]);
		const section = [...target.querySelectorAll("section")].find(
			(candidate) => candidate.querySelector("h2")?.textContent.trim() === "Potluck",
		);

		expect(section?.querySelector("strong")?.textContent).toBe("Hosts are providing:");

		button(target, "RSVP").click();
		flushSync();

		expect(target.querySelector("dialog .potluck-providing strong")?.textContent).toBe(
			"Hosts are providing:",
		);
	});

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
		expect(document.activeElement).toBe(panel.querySelectorAll(".panel-list-item")[8]);

		expect(
			[...panel.querySelectorAll("button")].some((b) => b.textContent.startsWith("Show all")),
		).toBe(false);
	});

	it("labels the song list as songs and shows the first 8 until Show all, then focuses the first revealed song", async () => {
		const target = render();
		const block = target.querySelector(".panel-block.tone-attending");
		const heading = [...target.querySelectorAll("h2")].find(
			(candidate) => candidate.textContent.trim() === "Add some music",
		);

		if (!block) {
			throw new Error("no song list");
		}

		expect(block.querySelector("h3")?.textContent.replaceAll(/\s+/g, " ").trim()).toBe(
			`✓ Attending (${guestNames.length} songs)`,
		);

		expect(heading?.parentElement?.querySelector(".badge-status")).toBeNull();

		expect(block.querySelectorAll("li")).toHaveLength(8);
		button(block, `Show all ${guestNames.length}`).click();
		await tick();
		await tick();

		expect(block.querySelectorAll("li")).toHaveLength(guestNames.length);
		expect(document.activeElement).toBe(block.querySelectorAll("li")[8]);
	});
});

describe("event page RSVP feedback", () => {
	it("shows Saved next to the existing RSVP status without a confirmation card", () => {
		const target = render({ type: "updateRsvp", success: true, message: "Updated" }, avery);

		expect(target.textContent).toContain("You're going ✓");
		expect(target.querySelector('[role="status"]')?.textContent).toContain("Saved");
		expect(target.querySelector(".success-banner")).toBeNull();

		expect(
			[...target.querySelectorAll("h2")].some((heading) =>
				heading.textContent?.includes("Updated!"),
			),
		).toBe(false);
	});

	it.each([
		["attending", "You're going ✓"],
		["maybe", "Maybe ✓"],
		["not_attending", "Can't make it ✓"],
	])("labels a %s RSVP as %s", (status, label) => {
		const target = render(null, { ...avery, status });

		expect(target.textContent).toContain(label);
	});

	it("shows an already-registered RSVP as information, not an error", () => {
		const target = render({
			type: "rsvp",
			success: false,
			alreadyRegistered: true,
			message: "You're already on the list.",
		});
		const status = target.querySelector('[role="status"]');

		expect(status?.textContent).toContain("You're already on the list.");
		expect(target.querySelector(".error-banner")).toBeNull();
	});
});
