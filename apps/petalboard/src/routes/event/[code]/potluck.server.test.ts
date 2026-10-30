import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FRIENDSGIVING_POTLUCK, type PotluckConfig } from "$lib/potluck";
import type * as PrismaModule from "$lib/server/prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ManageServer from "../manage/[token]/+page.server";
import type * as PageServer from "./+page.server";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/email", () => ({ sendRsvpEmail: vi.fn() }));

const dir = mkdtempSync(path.join(tmpdir(), "petalboard-potluck-"));

process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

type Actions = typeof PageServer.actions;
type Prisma = typeof PrismaModule.prisma;
let actions: Actions;
let prisma: Prisma;
let publicCode: string;
let manageToken: string;
let manageActions: typeof ManageServer.actions;
let questionId: string;
let guestSeq = 1000;

const strict: PotluckConfig = { ...FRIENDSGIVING_POTLUCK, minOptions: 1 };

type Jar = Map<string, string>;

function cookieJar(jar: Jar) {
	return {
		get: (name: string) => jar.get(name),
		set: (name: string, value: string) => jar.set(name, value),
		delete: (name: string) => jar.delete(name),
	};
}

function post(action: keyof Actions, fields: Record<string, string>, jar: Jar = new Map()) {
	const body = new FormData();

	body.set("guestCount", "1");

	for (const [k, v] of Object.entries(fields)) {
		body.set(k, v);
	}

	const request = new Request(`http://localhost/event/${publicCode}?/${action}`, {
		method: "POST",
		body,
	});
	const handler = actions[action] as (e: unknown) => Promise<any>;

	return handler({
		request,
		params: { code: publicCode },
		locals: {},
		cookies: cookieJar(jar),
		getClientAddress: () => "127.0.0.1",
	});
}

function signUp(category: string, dish: string) {
	const n = guestSeq++;
	const jar: Jar = new Map();

	return post(
		"rsvp",
		{
			name: `Guest ${n}`,
			email: `guest${n}@example.test`,
			status: "attending",
			[`response_${questionId}`]: JSON.stringify({ category, dish }),
		},
		jar,
	).then((result) => ({ result, jar }));
}

const accepted = (r: any) => r?.success === true;

async function countIn(category: string) {
	const rows = await prisma.response.findMany({ where: { questionId } });

	return rows.filter((r) => JSON.parse(r.value).category === category).length;
}

beforeAll(async () => {
	execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
		env: process.env,
		stdio: "ignore",
	});

	({ actions } = await import("./+page.server"));
	({ actions: manageActions } = await import("../manage/[token]/+page.server"));
	({ prisma } = await import("$lib/server/prisma"));
}, 60_000);

afterAll(async () => {
	await prisma?.$disconnect();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.user.deleteMany();

	const user = await prisma.user.create({
		data: { email: "host@example.test", passwordHash: "x", name: "Host" },
	});
	const event = await prisma.event.create({
		data: {
			title: "Test potluck",
			date: new Date("2026-11-26T18:00:00Z"),
			publicCode: `pc${guestSeq}`,
			manageToken: `mt${guestSeq}`,
			userId: user.id,
			questions: {
				create: {
					type: "potluck",
					label: "What are you bringing?",
					isPublic: true,
					potluckConfig: JSON.stringify(strict),
				},
			},
		},
		include: { questions: true },
	});

	publicCode = event.publicCode;
	manageToken = event.manageToken;
	questionId = event.questions[0].id;

	const seed = { sides: 5, "apps-snacks": 2, desserts: 1, drinks: 1 };

	for (const [category, n] of Object.entries(seed)) {
		for (let i = 0; i < n; i++) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Seed rows in a fixed order.
			await prisma.rsvp.create({
				data: {
					name: `Seed ${category} ${i}`,
					eventId: event.id,
					responses: {
						create: { questionId, value: JSON.stringify({ category, dish: `${category} ${i}` }) },
					},
				},
			});
		}
	}
});

describe("potluck signups", () => {
	it("accepts exactly the two desserts the ratio allows when eight guests submit at once", async () => {
		// 9 dishes, 1 dessert at 20%: dessert 2 fits ceil(0.2 * 10) = 2, dessert 3 fits ceil(0.2 * 11) = 3,
		// dessert 4 would need ceil(0.2 * 12) = 3, so exactly two more are accepted.
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) => signUp("desserts", `pie ${i}`)),
		);
		const outcomes = results.map(({ result }) =>
			accepted(result) ? "ok" : (result.status as number),
		);

		expect(outcomes.filter((o) => o === "ok")).toHaveLength(2);
		expect(outcomes.filter((o) => o === 409)).toHaveLength(6);
		expect(await countIn("desserts")).toBe(3);
	}, 60_000);

	it("tells a rejected guest which categories are still needed", async () => {
		await signUp("desserts", "pie a");
		await signUp("desserts", "pie b");
		const { result } = await signUp("desserts", "pie c");

		expect(result.status).toBe(409);
		expect(result.data.potluck.offered).not.toContain("desserts");
		expect(result.data.message).toMatch(/^Desserts is full for now\. Still needed: /);
	});

	it("frees a dessert slot when a guest cancels", async () => {
		await signUp("desserts", "pie a");
		const { jar } = await signUp("desserts", "pie b");

		expect(accepted((await signUp("desserts", "pie c")).result)).toBe(false);

		const cancelled = await post("cancelRsvp", {}, jar);

		expect(cancelled.success).toBe(true);
		expect(accepted((await signUp("desserts", "pie c")).result)).toBe(true);
	});

	it("frees a dessert slot when a guest edits their dish to a side", async () => {
		await signUp("desserts", "pie a");
		const { jar } = await signUp("desserts", "pie b");
		const edited = await post(
			"updateRsvp",
			{
				name: "Guest edited",
				status: "attending",
				[`response_${questionId}`]: JSON.stringify({ category: "sides", dish: "stuffing" }),
			},
			jar,
		);

		expect(edited.success).toBe(true);
		expect(await countIn("desserts")).toBe(2);
		expect(accepted((await signUp("desserts", "pie c")).result)).toBe(true);
	});

	it("lets a guest keep their dessert while editing after desserts closed", async () => {
		await signUp("desserts", "pie a");
		const { jar } = await signUp("desserts", "pie b");
		const edited = await post(
			"updateRsvp",
			{
				name: "Guest renamed",
				status: "attending",
				[`response_${questionId}`]: JSON.stringify({ category: "desserts", dish: "pecan pie" }),
			},
			jar,
		);

		expect(edited.success).toBe(true);
		expect(await countIn("desserts")).toBe(3);
	});

	it("lets a guest keep a dessert that is over its share, for example after a lifted override", async () => {
		const eventId = (await prisma.question.findUniqueOrThrow({ where: { id: questionId } }))
			.eventId;

		for (let i = 0; i < 4; i++) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Seed rows in a fixed order.
			await prisma.rsvp.create({
				data: {
					name: `Forced dessert ${i}`,
					eventId,
					responses: {
						create: {
							questionId,
							value: JSON.stringify({ category: "desserts", dish: `cake ${i}` }),
						},
					},
				},
			});
		}

		const own = await prisma.rsvp.findFirstOrThrow({ where: { name: "Forced dessert 0" } });
		const { createSession } = await import("$lib/server/rsvpAccess");
		const jar: Jar = new Map([["pb_rsvp", await createSession(own.id)]]);
		const edited = await post(
			"updateRsvp",
			{
				name: "Forced dessert renamed",
				status: "attending",
				[`response_${questionId}`]: JSON.stringify({ category: "desserts", dish: "carrot cake" }),
			},
			jar,
		);

		expect(edited.success).toBe(true);
		expect(accepted((await signUp("desserts", "one more cake")).result)).toBe(false);
	});

	it("does not hold a slot for a guest who can't come, and does count a maybe", async () => {
		await signUp("desserts", "pie a");
		await signUp("desserts", "pie b");
		expect(accepted((await signUp("desserts", "pie c")).result)).toBe(false);

		const holder = await prisma.rsvp.findFirstOrThrow({ where: { name: "Seed desserts 0" } });

		await prisma.rsvp.update({ where: { id: holder.id }, data: { status: "maybe" } });
		expect(accepted((await signUp("desserts", "pie c")).result)).toBe(false);

		await prisma.rsvp.update({ where: { id: holder.id }, data: { status: "not_attending" } });
		expect(accepted((await signUp("desserts", "pie c")).result)).toBe(true);
	});

	it("removes a guest's dish when they choose not to bring one", async () => {
		const { result, jar } = await signUp("desserts", "pie");

		expect(accepted(result)).toBe(true);

		const edited = await post(
			"updateRsvp",
			{ name: "Guest no dish", status: "attending", [`response_${questionId}`]: "" },
			jar,
		);
		const own = await prisma.rsvp.findFirstOrThrow({ where: { name: "Guest no dish" } });

		expect(edited.success).toBe(true);
		expect(await prisma.response.count({ where: { rsvpId: own.id } })).toBe(0);
	});

	it("keeps the host's force-open and its removal when the question is edited", async () => {
		const update = (config: PotluckConfig) => {
			const body = new FormData();

			body.set("questionId", questionId);
			body.set("type", "potluck");
			body.set("label", "What are you bringing?");
			body.set("description", "");
			body.set("isPublic", "on");
			body.set("potluckConfig", JSON.stringify(config));
			const handler = manageActions.updateQuestion as (e: unknown) => Promise<any>;

			return handler({
				request: new Request("http://localhost/", { method: "POST", body }),
				params: { token: manageToken },
			});
		};

		const override = (forceOpen: boolean) => {
			const body = new FormData();

			body.set("questionId", questionId);
			body.set("categoryId", "desserts");
			body.set("forceOpen", String(forceOpen));
			const handler = manageActions.setPotluckOverride as (e: unknown) => Promise<any>;

			return handler({
				request: new Request("http://localhost/", { method: "POST", body }),
				params: { token: manageToken },
			});
		};

		const dessertsForced = async () => {
			const q = await prisma.question.findUniqueOrThrow({ where: { id: questionId } });

			return (JSON.parse(q.potluckConfig ?? "{}") as PotluckConfig).categories.find(
				(c) => c.id === "desserts",
			)?.forceOpen;
		};

		const staleDraft = (forceOpen: boolean): PotluckConfig => ({
			...strict,
			providing: "Edited",
			categories: strict.categories.map((c) => ({
				...c,
				forceOpen: c.id === "desserts" && forceOpen,
			})),
		});

		expect(await override(true)).toMatchObject({ success: true });
		expect((await update(staleDraft(false))).success).toBe(true);
		expect(await dessertsForced()).toBe(true);

		expect((await override(false)).success).toBe(true);
		expect((await update(staleDraft(true))).success).toBe(true);
		expect(await dessertsForced()).toBe(false);
	});

	it("asks the guest to retry when the signup transaction times out", async () => {
		const busy = Object.assign(new Error("Transaction already closed"), { code: "P2028" });
		const spy = vi.spyOn(prisma, "$transaction").mockRejectedValue(busy);

		try {
			const { result } = await signUp("desserts", "pie");

			expect(result.status).toBe(503);
			expect(result.data.message).toMatch(/try again/);
		} finally {
			spy.mockRestore();
		}
	});

	it("rejects free text that is not a category and dish", async () => {
		const result = await post("rsvp", {
			name: "Guest free text",
			email: "free.text@example.test",
			status: "attending",
			[`response_${questionId}`]: "brownies",
		});

		expect(result.status).toBe(409);
		expect(await prisma.rsvp.count({ where: { name: "Guest free text" } })).toBe(0);
	});
});
