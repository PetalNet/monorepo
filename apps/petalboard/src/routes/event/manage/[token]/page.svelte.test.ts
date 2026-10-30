// @vitest-environment happy-dom
import type { SubmitFunction } from "@sveltejs/kit";
import { flushSync, mount, tick, unmount } from "svelte";
import { readable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageData } from "./$types";
import Page from "./+page.svelte";

const submitters = new Map<string, SubmitFunction>();

vi.mock("$app/forms", () => ({
	enhance: (form: HTMLFormElement, submit: SubmitFunction) => {
		submitters.set(form.getAttribute("action") ?? "", submit);

		return { destroy: () => submitters.delete(form.getAttribute("action") ?? "") };
	},
}));

vi.mock("$app/stores", () => ({
	page: readable({ url: new URL("http://localhost/event/manage/token") }),
}));

vi.mock("$env/dynamic/public", () => ({ env: {} }));

type Question = PageData["event"]["questions"][number];

function question(id: string, label: string, order: number): Question {
	return {
		id,
		type: "text",
		label,
		description: null,
		required: false,
		options: null,
		quantity: null,
		isPublic: false,
		order,
		responseCount: 0,
		spotifyPlaylistId: null,
		songsPerUser: null,
		potluck: null,
	};
}

function pageData(questions: Question[]): PageData {
	return {
		user: null,
		hasSpotifyConnected: false,
		event: {
			id: "event-1",
			title: "Friendsgiving",
			description: null,
			date: new Date("2026-11-28T23:00:00Z"),
			endDate: null,
			timezone: "America/Chicago",
			location: null,
			rsvpLimit: null,
			publicCode: "CODE1234",
			theme: "light",
			primaryColor: null,
			secondaryColor: null,
			backgroundImage: null,
			emoji: null,
			questions,
		},
		rsvps: [],
	};
}

function renderedQuestionLabels(target: HTMLElement): string[] {
	return [...target.querySelectorAll("article h3")].map((h) => h.textContent.trim());
}

let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	submitters.clear();
});

describe("manage page: add question", () => {
	it("shows a newly added question once after the page data reloads", async () => {
		const existing = question("q1", "Dietary needs", 0);
		const added = question("q2", "What are you bringing?", 1);
		const props = $state({ data: pageData([existing]), form: null });
		const target = document.createElement("div");

		document.body.append(target);
		const component = mount(Page, { target, props });

		cleanup = () => {
			void unmount(component);
			target.remove();
		};

		const openModal = [...target.querySelectorAll("button")].find((b) =>
			b.textContent.includes("Add Question"),
		);

		expect(openModal).toBeDefined();
		openModal?.click();
		flushSync();

		const submit = submitters.get("?/addQuestion");

		expect(submit).toBeDefined();
		const form = target.querySelector<HTMLFormElement>('form[action="?/addQuestion"]');

		if (!submit || !form) {
			throw new Error("add-question form did not mount");
		}

		const after = await submit({
			action: new URL("http://localhost/event/manage/token?/addQuestion"),
			formData: new FormData(form),
			formElement: form,
			controller: new AbortController(),
			submitter: null,
			cancel: () => undefined,
		});

		if (typeof after !== "function") {
			throw new TypeError("enhance callback did not return a result handler");
		}

		await after({
			action: new URL("http://localhost/event/manage/token?/addQuestion"),
			formData: new FormData(form),
			formElement: form,
			result: { type: "success", status: 200, data: { success: true, question: added } },
			// SvelteKit's update() reruns load and hands the page fresh data.
			update: async () => {
				props.data = pageData([existing, added]);
				await tick();
			},
		});

		flushSync();

		expect(renderedQuestionLabels(target)).toEqual(["Dietary needs", "What are you bringing?"]);
	});
});
