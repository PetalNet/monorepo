import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as EmailModule from "$lib/server/email";
import type * as PrismaModule from "$lib/server/prisma";
import type * as AccessModule from "$lib/server/rsvpAccess";
import { isRedirect } from "@sveltejs/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PageServer from "./+page.server";
import type * as EditServer from "./edit/+page.server";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/email", () => ({ sendRsvpEmail: vi.fn(async () => undefined) }));

const dir = mkdtempSync(path.join(tmpdir(), "petalboard-rsvp-access-"));

process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

type CookieOptions = Record<string, unknown>;
type Jar = Map<string, { value: string; options: CookieOptions }>;

let page: typeof PageServer;
let edit: typeof EditServer;
let access: typeof AccessModule;
let sendRsvpEmail: ReturnType<typeof vi.fn<typeof EmailModule.sendRsvpEmail>>;
let prisma: typeof PrismaModule.prisma;
let publicCode: string;
let eventId: string;
let seq = 0;
let ip: string;

function cookies(jar: Jar) {
	return {
		get: (name: string) => jar.get(name)?.value,
		set: (name: string, value: string, options: CookieOptions) => jar.set(name, { value, options }),
		delete: (name: string) => jar.delete(name),
	};
}

function call(
	handler: unknown,
	init: { body?: FormData; url?: string; jar?: Jar; headers?: HeadersInit },
) {
	const url = init.url ?? `http://localhost/event/${publicCode}`;
	const request = new Request(url, { method: "POST", body: init.body, headers: init.headers });

	return (handler as (e: unknown) => Promise<any>)({
		request,
		url: new URL(url),
		params: { code: publicCode },
		locals: { user: null },
		cookies: cookies(init.jar ?? new Map()),
		getClientAddress: () => ip,
		setHeaders: vi.fn(),
	});
}

function form(fields: Record<string, string>) {
	const body = new FormData();

	for (const [k, v] of Object.entries(fields)) {
		body.set(k, v);
	}

	return body;
}

function rsvp(fields: Record<string, string>, jar: Jar = new Map()) {
	return call(page.actions.rsvp, {
		body: form({ guestCount: "1", status: "attending", ...fields }),
		jar,
	});
}

function requestEditLink(email: string, headers?: HeadersInit) {
	return call(page.actions.requestEditLink, { body: form({ email }), headers });
}

async function continueWithLink(
	token: string,
	jar: Jar,
): Promise<{ status: number; redirect?: string; data?: unknown }> {
	try {
		return (await call(edit.actions.default, {
			body: form({ token }),
			url: `http://localhost/event/${publicCode}/edit?token=${token}`,
			jar,
		})) as { status: number; data: unknown };
	} catch (thrown) {
		if (isRedirect(thrown)) {
			return { redirect: thrown.location, status: thrown.status };
		}

		throw thrown;
	}
}

async function sentEmails() {
	await access.backgroundSettled();

	return sendRsvpEmail.mock.calls.map(([kind, to, , token]) => ({ kind, to, token }));
}

async function seedRsvp(email: string) {
	return prisma.rsvp.create({ data: { name: "Seeded Guest", email, eventId } });
}

beforeAll(async () => {
	execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
		env: process.env,
		stdio: "ignore",
	});

	page = await import("./+page.server");
	edit = await import("./edit/+page.server");
	access = await import("$lib/server/rsvpAccess");
	({ prisma } = await import("$lib/server/prisma"));
	sendRsvpEmail = vi.mocked((await import("$lib/server/email")).sendRsvpEmail);
}, 60_000);

afterAll(async () => {
	await access?.backgroundSettled();
	await prisma?.$disconnect();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await access.backgroundSettled();
	sendRsvpEmail.mockClear();
	await prisma.user.deleteMany();
	seq += 1;
	ip = `10.0.0.${seq}`;

	const user = await prisma.user.create({
		data: { email: "host@example.test", passwordHash: "x", name: "Host" },
	});
	const event = await prisma.event.create({
		data: {
			title: "Garden party",
			date: new Date("2026-11-26T18:00:00Z"),
			publicCode: `pc${seq}`,
			manageToken: `mt${seq}`,
			userId: user.id,
		},
	});

	publicCode = event.publicCode;
	eventId = event.id;
});

describe("passwordless RSVP access", () => {
	it("sets a 400-day, httpOnly, secure, lax cookie scoped to the event", async () => {
		const jar: Jar = new Map();

		expect((await rsvp({ name: "Avery", email: `avery.${seq}@example.test` }, jar)).success).toBe(
			true,
		);

		expect(jar.get("pb_rsvp")?.options).toStrictEqual({
			path: `/event/${publicCode}`,
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			maxAge: 400 * 24 * 60 * 60,
		});

		expect((await sentEmails()).map((e) => [e.kind, e.to])).toEqual([
			["confirmation", `avery.${seq}@example.test`],
		]);
	});

	it("refuses a name over 100 characters and sends nothing", async () => {
		const result = await rsvp({ name: "x".repeat(101), email: `long.${seq}@example.test` });

		expect(result.status).toBe(400);
		expect(result.data.errors.name).toEqual(["Name must be 100 characters or fewer"]);
		expect(await prisma.rsvp.count({ where: { eventId } })).toBe(0);
		expect(await sentEmails()).toEqual([]);
	});

	it("does not consume the link or set a cookie when a scanner GETs it", async () => {
		await rsvp({ name: "Avery", email: `avery.${seq}@example.test` });
		const [{ token }] = await sentEmails();
		const jar: Jar = new Map();

		for (let i = 0; i < 3; i++) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Each GET runs after the last, like a scanner.
			const data = await call(edit.load, {
				url: `http://localhost/event/${publicCode}/edit?token=${token}`,
				jar,
			});

			expect(data.token).toBe(token);
		}

		expect(await prisma.rsvpLink.findMany({ select: { usedAt: true } })).toEqual([
			{ usedAt: null },
		]);

		expect(jar.size).toBe(0);

		expect(await continueWithLink(token, jar)).toStrictEqual({
			redirect: `/event/${publicCode}?edit=1`,
			status: 303,
		});

		expect(jar.has("pb_rsvp")).toBe(true);
	});

	it("never overwrites an RSVP for a known email without that RSVP's cookie", async () => {
		const owner: Jar = new Map();

		await rsvp({ name: "Avery", email: `Avery.${seq}@Example.test`, status: "attending" }, owner);
		const before = await prisma.rsvp.findFirstOrThrow({ where: { eventId } });
		const stranger: Jar = new Map();
		const result = await rsvp(
			{ name: "Impostor", email: `  avery.${seq}@EXAMPLE.test `, status: "not_attending" },
			stranger,
		);

		expect(result.status).toBe(409);
		expect(result.data).toStrictEqual({
			success: false,
			type: "rsvp",
			alreadyRegistered: true,
			message:
				"You're already on the list. Check your email for a link to edit your RSVP, or use Edit my RSVP to get a new one.",
		});
		expect(await prisma.rsvp.findMany({ where: { eventId } })).toStrictEqual([before]);
		expect(stranger.size).toBe(0);

		const already = (await sentEmails()).filter((e) => e.kind === "already");

		expect(already.map((e) => e.to)).toEqual([`avery.${seq}@example.test`]);
		expect((await continueWithLink(already[0].token, owner)).status).toBe(303);

		const updated = await rsvp(
			{ name: "Avery Q", email: `avery.${seq}@example.test`, status: "maybe" },
			owner,
		);

		expect(updated.success).toBe(true);

		expect(await prisma.rsvp.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
			name: "Avery Q",
			status: "maybe",
		});
	});

	it("answers identically for registered and unknown emails and only mails the registered one", async () => {
		await seedRsvp(`known.${seq}@example.test`);

		const known = await requestEditLink(`known.${seq}@example.test`);
		const unknown = await requestEditLink(`nobody.${seq}@example.test`);

		expect(known).toStrictEqual(unknown);

		expect((await sentEmails()).map((e) => [e.kind, e.to])).toEqual([
			["requested", `known.${seq}@example.test`],
		]);
	});

	it("signs out every other browser on the RSVP when its link is used", async () => {
		const squatter: Jar = new Map();

		await rsvp({ name: "Squatter", email: `victim.${seq}@example.test` }, squatter);
		const own = await prisma.rsvp.findFirstOrThrow({ where: { eventId } });
		const [{ token }] = await sentEmails();

		expect((await continueWithLink(token, new Map())).status).toBe(303);

		const fields = { name: "Squatter again", status: "attending", expectedRsvpId: own.id };
		const updated = await call(page.actions.updateRsvp, { body: form(fields), jar: squatter });

		expect([updated.status, updated.data?.message]).toEqual([
			403,
			"Your edit access has expired. Use Edit my RSVP to get a new link.",
		]);

		expect(await prisma.rsvpSession.count({ where: { rsvpId: own.id } })).toBe(1);
	});

	it("accepts a link once", async () => {
		await seedRsvp(`once.${seq}@example.test`);
		await requestEditLink(`once.${seq}@example.test`);
		const [{ token }] = await sentEmails();

		expect((await continueWithLink(token, new Map())).status).toBe(303);

		const second: Jar = new Map();
		const again = await continueWithLink(token, second);

		expect(again.status).toBe(400);
		expect(again.data).toStrictEqual({ expired: true });
		expect(second.size).toBe(0);
	});

	it("rejects a link after 60 minutes", async () => {
		await seedRsvp(`late.${seq}@example.test`);
		await requestEditLink(`late.${seq}@example.test`);
		const [{ token }] = await sentEmails();
		const jar: Jar = new Map();

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 61 * 60 * 1000);

		try {
			expect((await continueWithLink(token, jar)).status).toBe(400);
		} finally {
			vi.useRealTimers();
		}

		expect(jar.size).toBe(0);
	});

	it("refuses update and cancel without the RSVP's cookie, whatever the form says", async () => {
		const own = await seedRsvp(`held.${seq}@example.test`);
		const before = await prisma.rsvp.findUniqueOrThrow({ where: { id: own.id } });
		const fields = { rsvpId: own.id, name: "Hijacked", status: "not_attending", guestCount: "1" };

		const updated = await call(page.actions.updateRsvp, { body: form(fields) });
		const cancelled = await call(page.actions.cancelRsvp, { body: form({ rsvpId: own.id }) });

		expect([updated.status, cancelled.status]).toEqual([403, 403]);
		expect(await prisma.rsvp.findUniqueOrThrow({ where: { id: own.id } })).toStrictEqual(before);
	});

	// The jar's cookie moves to Second, as when Second's edit link opens in another tab.
	async function twoRsvpsOneBrowser() {
		const jar: Jar = new Map();

		await rsvp({ name: "First", email: `first.${seq}@example.test` }, jar);
		await rsvp({ name: "Second", email: `second.${seq}@example.test` }, jar);

		return {
			jar,
			first: await prisma.rsvp.findFirstOrThrow({ where: { name: "First" } }),
			before: await prisma.rsvp.findMany({ where: { eventId }, orderBy: { name: "asc" } }),
		};
	}

	const stale = [409, "This page is out of date. Reload to edit your current RSVP."];

	it("refuses an update from a dialog showing a different RSVP than the cookie's", async () => {
		const { jar, first, before } = await twoRsvpsOneBrowser();
		const fields = { name: "Overwritten", status: "not_attending", guestCount: "1" };
		const results = [
			await call(page.actions.updateRsvp, {
				body: form({ ...fields, expectedRsvpId: first.id }),
				jar,
			}),
			await call(page.actions.updateRsvp, { body: form(fields), jar }),
		];

		expect(results.map((r) => [r.status, r.data?.message ?? r.message])).toEqual([stale, stale]);

		expect(
			await prisma.rsvp.findMany({ where: { eventId }, orderBy: { name: "asc" } }),
		).toStrictEqual(before);
	});

	it("refuses a cancel from a dialog showing a different RSVP than the cookie's", async () => {
		const { jar, first, before } = await twoRsvpsOneBrowser();
		const results = [
			await call(page.actions.cancelRsvp, { body: form({ expectedRsvpId: first.id }), jar }),
			await call(page.actions.cancelRsvp, { body: form({}), jar }),
		];

		expect(results.map((r) => [r.status, r.data?.message ?? r.message])).toEqual([stale, stale]);

		expect(
			await prisma.rsvp.findMany({ where: { eventId }, orderBy: { name: "asc" } }),
		).toStrictEqual(before);
	});

	it("cancels with the cookie, deletes the RSVP and clears the cookie", async () => {
		const jar: Jar = new Map();

		await rsvp({ name: "Avery", email: `avery.${seq}@example.test` }, jar);
		const own = await prisma.rsvp.findFirstOrThrow({ where: { eventId } });
		const cancelled = await call(page.actions.cancelRsvp, {
			body: form({ expectedRsvpId: own.id }),
			jar,
		});

		expect(cancelled.success).toBe(true);
		expect(await prisma.rsvp.count({ where: { eventId } })).toBe(0);
		expect(jar.size).toBe(0);
	});

	it("returns myRsvp only to the browser holding its cookie", async () => {
		const jar: Jar = new Map();

		await rsvp({ name: "Avery", email: `avery.${seq}@example.test`, guestCount: "2" }, jar);

		expect((await call(page.load, { jar })).myRsvp).toMatchObject({
			name: "Avery",
			email: `avery.${seq}@example.test`,
			guestCount: 2,
		});

		expect((await call(page.load, {})).myRsvp).toBeNull();
	});

	it("stops mailing an address after 3 links in 15 minutes but answers the same", async () => {
		await seedRsvp(`busy.${seq}@example.test`);

		const results = [];

		for (let i = 0; i < 4; i++) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- The limiter counts requests in order.
			results.push(await requestEditLink(`busy.${seq}@example.test`));
		}

		expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
		expect(await sentEmails()).toHaveLength(3);
	});

	it("keeps a separate per-IP budget for each cf-connecting-ip", async () => {
		for (let i = 0; i < 20; i++) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Fill one IP's window in order.
			await requestEditLink(`nobody${i}.${seq}@example.test`, {
				"cf-connecting-ip": "203.0.113.1",
			});
		}

		await access.backgroundSettled();

		const blocked = await requestEditLink(`x.${seq}@example.test`, {
			"cf-connecting-ip": "203.0.113.1",
		});
		const other = await requestEditLink(`x.${seq}@example.test`, {
			"cf-connecting-ip": "203.0.113.2",
		});

		expect(blocked.status).toBe(429);
		expect(other.success).toBe(true);
	});
});
