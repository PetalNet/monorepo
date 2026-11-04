import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FRIENDSGIVING_POTLUCK } from "$lib/potluck";
import type { User } from "$lib/server/generated/prisma/client";
import type * as PrismaModule from "$lib/server/prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ManageServer from "./+page.server";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));

const dir = mkdtempSync(path.join(tmpdir(), "petalboard-manage-"));

process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

type Actions = typeof ManageServer.actions;
type ActionName = keyof Actions;

let actions: Actions;
let load: typeof ManageServer.load;
let prisma: typeof PrismaModule.prisma;
let owner: User;
let stranger: User;
let publicCode: string;
let eventId: string;
let textQuestionId: string;
let potluckQuestionId: string;
let rsvpId: string;

// Typed on every action name, so a new action fails typecheck until it is covered here.
const forms: Record<ActionName, () => Record<string, string>> = {
	updateEvent: () => ({
		title: "Renamed party",
		date: "2026-11-26T18:00",
		timezone: "America/Chicago",
		...Object.fromEntries(
			[
				"endDate",
				"location",
				"description",
				"primaryColor",
				"secondaryColor",
				"backgroundImage",
				"emoji",
			].map((field) => [field, ""]),
		),
	}),
	addQuestion: () => ({ type: "text", label: "Any allergies?", description: "" }),
	updateQuestion: () => ({
		questionId: textQuestionId,
		type: "text",
		label: "Edited label",
		description: "",
	}),
	setPotluckOverride: () => ({
		questionId: potluckQuestionId,
		categoryId: "desserts",
		forceOpen: "true",
	}),
	deleteQuestion: () => ({ questionId: textQuestionId }),
	deleteRsvp: () => ({ rsvpId }),
	deleteEvent: () => ({}),
};

function call(name: ActionName, user: User | null, code = publicCode) {
	const body = new FormData();

	for (const [k, v] of Object.entries(forms[name]())) {
		body.set(k, v);
	}

	const handler = actions[name] as (e: unknown) => Promise<any>;

	return handler({
		request: new Request(`http://localhost/event/${code}/manage?/${name}`, {
			method: "POST",
			body,
		}),
		params: { code },
		locals: { user },
	});
}

function snapshot() {
	return prisma.event.findUnique({
		where: { id: eventId },
		include: { questions: { orderBy: { id: "asc" } }, rsvps: { orderBy: { id: "asc" } } },
	});
}

const actionNames = () => Object.keys(actions) as ActionName[];

beforeAll(async () => {
	execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
		env: process.env,
		stdio: "ignore",
	});

	({ actions, load } = await import("./+page.server"));
	({ prisma } = await import("$lib/server/prisma"));
}, 60_000);

afterAll(async () => {
	await prisma?.$disconnect();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.user.deleteMany();

	owner = await prisma.user.create({
		data: { email: "host@example.test", passwordHash: "x", name: "Host" },
	});

	stranger = await prisma.user.create({
		data: { email: "stranger@example.test", passwordHash: "x", name: "Stranger" },
	});

	const event = await prisma.event.create({
		data: {
			title: "Garden party",
			date: new Date("2026-11-26T18:00:00Z"),
			publicCode: "pcowner",
			userId: owner.id,
			questions: {
				create: [
					{ type: "text", label: "Song request", order: 0 },
					{
						type: "potluck",
						label: "What are you bringing?",
						order: 1,
						potluckConfig: JSON.stringify(FRIENDSGIVING_POTLUCK),
					},
				],
			},
			rsvps: { create: { name: "Avery" } },
		},
		include: { questions: true, rsvps: true },
	});

	publicCode = event.publicCode;
	eventId = event.id;
	textQuestionId = event.questions.find((q) => q.type === "text")!.id;
	potluckQuestionId = event.questions.find((q) => q.type === "potluck")!.id;
	rsvpId = event.rsvps[0].id;
});

describe("manage page owner guard", () => {
	it("rejects every action from a signed-in non-owner with 403 and changes nothing", async () => {
		const before = await snapshot();

		for (const name of actionNames()) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Each action runs against the same seeded event.
			await expect(call(name, stranger), name).rejects.toMatchObject({ status: 403 });
		}

		expect(await snapshot()).toStrictEqual(before);
	});

	it("sends every action without a session to the login page and changes nothing", async () => {
		const before = await snapshot();

		for (const name of actionNames()) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Each action runs against the same seeded event.
			await expect(call(name, null), name).rejects.toMatchObject({
				status: 303,
				location: "/login",
			});
		}

		expect(await snapshot()).toStrictEqual(before);
	});

	it("returns 404 for an unknown event code", async () => {
		await expect(call("deleteEvent", owner, "nosuchcode")).rejects.toMatchObject({ status: 404 });
	});

	it("rejects the page load for a non-owner and serves it to the owner", async () => {
		const run = load as (e: unknown) => Promise<any>;

		await expect(
			run({ params: { code: publicCode }, locals: { user: stranger } }),
		).rejects.toMatchObject({ status: 403 });

		await expect(
			run({ params: { code: publicCode }, locals: { user: null } }),
		).rejects.toMatchObject({
			status: 303,
			location: "/login",
		});

		expect((await run({ params: { code: publicCode }, locals: { user: owner } })).event.id).toBe(
			eventId,
		);
	});
});

describe("manage actions as the owner", () => {
	it("updateEvent saves the new details", async () => {
		expect(await call("updateEvent", owner)).toMatchObject({ success: true });
		expect((await snapshot())?.title).toBe("Renamed party");
	});

	it("addQuestion adds a question", async () => {
		expect(await call("addQuestion", owner)).toMatchObject({ success: true });
		expect((await snapshot())?.questions.map((q) => q.label)).toContain("Any allergies?");
	});

	it("updateQuestion edits the question", async () => {
		expect(await call("updateQuestion", owner)).toMatchObject({ success: true });

		expect((await prisma.question.findUniqueOrThrow({ where: { id: textQuestionId } })).label).toBe(
			"Edited label",
		);
	});

	it("setPotluckOverride forces a category open", async () => {
		expect(await call("setPotluckOverride", owner)).toMatchObject({ success: true });

		const q = await prisma.question.findUniqueOrThrow({ where: { id: potluckQuestionId } });

		expect(
			JSON.parse(q.potluckConfig ?? "{}").categories.find(
				(c: { id: string }) => c.id === "desserts",
			).forceOpen,
		).toBe(true);
	});

	it("deleteQuestion removes the question", async () => {
		expect(await call("deleteQuestion", owner)).toMatchObject({ success: true });
		expect(await prisma.question.findUnique({ where: { id: textQuestionId } })).toBeNull();
	});

	it("deleteRsvp removes the RSVP", async () => {
		expect(await call("deleteRsvp", owner)).toMatchObject({ success: true });
		expect(await prisma.rsvp.findUnique({ where: { id: rsvpId } })).toBeNull();
	});

	it("deleteEvent removes the event and returns to the dashboard", async () => {
		await expect(call("deleteEvent", owner)).rejects.toMatchObject({
			status: 303,
			location: "/dashboard",
		});

		expect(await snapshot()).toBeNull();
	});
});
