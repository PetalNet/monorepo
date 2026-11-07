import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FRIENDSGIVING_POTLUCK } from "$lib/potluck";
import type * as PrismaModule from "$lib/server/prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PageServer from "./+page.server";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/email", () => ({ sendRsvpEmail: vi.fn(async () => undefined) }));

const dir = mkdtempSync(path.join(tmpdir(), "petalboard-rsvp-privacy-"));

process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

const markers = {
	public: "PUBLIC_ANSWER_MARKER",
	potluck: "PRIVATE_POTLUCK_DISH_MARKER",
	spotify: "PRIVATE_SPOTIFY_TRACK_MARKER",
	text: "PRIVATE_TEXT_ANSWER_MARKER",
};

type Jar = Map<string, string>;

let page: typeof PageServer;
let prisma: typeof PrismaModule.prisma;
let publicCode: string;
let ownerId: string;
let otherUserId: string;
let guestId: string;
let seq = 0;

function cookies(jar: Jar) {
	return {
		get: (name: string) => jar.get(name),
		set: (name: string, value: string) => jar.set(name, value),
		delete: (name: string) => jar.delete(name),
	};
}

function load(locals: { user?: { id: string } }, jar: Jar = new Map()) {
	return page.load({
		params: { code: publicCode },
		locals,
		cookies: cookies(jar),
		setHeaders: vi.fn(),
	} as never);
}

function submit(locals: { user?: { id: string } }, name: string, email: string) {
	const body = new FormData();

	body.set("name", name);
	body.set("email", email);
	body.set("status", "attending");
	body.set("guestCount", "1");

	// The direct action harness provides only the fields this action uses.
	const rsvp = page.actions.rsvp as (event: unknown) => ReturnType<typeof page.actions.rsvp>;

	return rsvp({
		request: new Request(`http://localhost/event/${publicCode}`, { method: "POST", body }),
		params: { code: publicCode },
		locals,
		cookies: cookies(new Map()),
		getClientAddress: () => `10.1.0.${seq}`,
	});
}

function answers(result: Awaited<ReturnType<typeof load>>) {
	return result.rsvps.flatMap((rsvp) => rsvp.responses.map((response) => response.answer));
}

beforeAll(async () => {
	execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
		env: process.env,
		stdio: "ignore",
	});

	page = await import("./+page.server");
	({ prisma } = await import("$lib/server/prisma"));
}, 60_000);

afterAll(async () => {
	await prisma?.$disconnect();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.user.deleteMany();
	seq += 1;

	const [owner, other] = await Promise.all([
		prisma.user.create({
			data: { email: `owner${seq}@example.test`, passwordHash: "x", name: "Owner" },
		}),
		prisma.user.create({
			data: { email: `other${seq}@example.test`, passwordHash: "x", name: "Other" },
		}),
	]);

	ownerId = owner.id;
	otherUserId = other.id;

	const event = await prisma.event.create({
		data: {
			title: "Private answers",
			date: new Date("2026-11-26T18:00:00Z"),
			publicCode: `privacy${seq}`,
			manageToken: `privacy-token${seq}`,
			userId: owner.id,
			questions: {
				create: [
					{ label: "Public", type: "text", isPublic: true },
					{ label: "Private text", type: "text", isPublic: false },
					{
						label: "Private potluck",
						type: "potluck",
						isPublic: false,
						potluckConfig: JSON.stringify(FRIENDSGIVING_POTLUCK),
					},
					{ label: "Private playlist", type: "spotify_playlist", isPublic: false },
				],
			},
		},
		include: { questions: true },
	});

	publicCode = event.publicCode;

	const questionId = Object.fromEntries(
		event.questions.map((question) => [question.label, question.id]),
	);
	const privateResponses = [
		{ questionId: questionId.Public, value: markers.public },
		{ questionId: questionId["Private text"], value: markers.text },
		{
			questionId: questionId["Private potluck"],
			value: JSON.stringify({ category: "sides", dish: markers.potluck }),
		},
		{
			questionId: questionId["Private playlist"],
			value: JSON.stringify([{ uri: `spotify:track:${markers.spotify}` }]),
		},
	];

	const guests = await Promise.all(
		["Guest One", "Guest Two"].map((name) =>
			prisma.rsvp.create({
				data: {
					name,
					email: `${name.replace(" ", ".").toLowerCase()}${seq}@example.test`,
					eventId: event.id,
					responses: { create: privateResponses },
				},
			}),
		),
	);

	guestId = guests[0].id;
});

describe("RSVP response privacy", () => {
	it("shows private answers only to the owner while retaining a guest's own RSVP", async () => {
		const anonymous = await load({});
		const signedInGuest = await load({ user: { id: otherUserId } });
		const owner = await load({ user: { id: ownerId } });

		for (const result of [anonymous, signedInGuest]) {
			expect(answers(result)).toEqual([markers.public, markers.public]);
			expect(JSON.stringify(result)).not.toContain(markers.text);
			expect(JSON.stringify(result)).not.toContain(markers.potluck);
			expect(JSON.stringify(result)).not.toContain(markers.spotify);
		}

		expect(answers(owner)).toEqual(
			expect.arrayContaining([
				markers.public,
				markers.text,
				JSON.stringify({ category: "sides", dish: markers.potluck }),
				JSON.stringify([{ uri: `spotify:track:${markers.spotify}` }]),
			]),
		);

		const guestJar: Jar = new Map();
		const { createSession, setRsvpCookie } = await import("$lib/server/rsvpAccess");

		setRsvpCookie(cookies(guestJar) as never, publicCode, await createSession(guestId));
		const ownRsvp = await load({}, guestJar);

		expect(Object.values(ownRsvp.myRsvp?.responses ?? {})).toEqual(
			expect.arrayContaining([
				markers.public,
				markers.text,
				JSON.stringify({ category: "sides", dish: markers.potluck }),
				JSON.stringify([{ uri: `spotify:track:${markers.spotify}` }]),
			]),
		);
	});

	it("does not leak existing private answers from RSVP actions, but returns them to the owner", async () => {
		const guestResult = await submit({}, "New guest", `new-guest${seq}@example.test`);
		const ownerResult = await submit(
			{ user: { id: ownerId } },
			"Owner guest",
			`owner-guest${seq}@example.test`,
		);

		expect(JSON.stringify(guestResult)).not.toContain(markers.text);
		expect(JSON.stringify(guestResult)).not.toContain(markers.potluck);
		expect(JSON.stringify(guestResult)).not.toContain(markers.spotify);

		if (!("rsvps" in guestResult)) {
			throw new Error("Expected a successful RSVP response");
		}

		expect(
			guestResult.rsvps.flatMap((rsvp) => rsvp.responses.map((response) => response.answer)),
		).toContain(markers.public);

		expect(JSON.stringify(ownerResult)).toContain(markers.text);
		expect(JSON.stringify(ownerResult)).toContain(markers.potluck);
		expect(JSON.stringify(ownerResult)).toContain(markers.spotify);
	});
});
