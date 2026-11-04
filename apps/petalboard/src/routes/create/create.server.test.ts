import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eventTheme } from "$lib/eventTheme";
import type * as PrismaModule from "$lib/server/prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PageServer from "./+page.server";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));

const dir = mkdtempSync(path.join(tmpdir(), "petalboard-create-"));

process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

let actions: typeof PageServer.actions;
let prisma: typeof PrismaModule.prisma;
let userId: string;

// The fields the create form posts while "Customize appearance" is collapsed.
const collapsedForm = {
	title: "Garden party",
	date: "2026-11-26T18:00",
	endDate: "",
	timezone: "America/Chicago",
	rsvpLimit: "",
	maxPlusOnes: "",
	location: "",
	description: "",
};

async function create(fields: Record<string, string>) {
	const body = new FormData();

	for (const [k, v] of Object.entries(fields)) {
		body.set(k, v);
	}

	const request = new Request("http://localhost/create", { method: "POST", body });

	const handler = actions.default as (event: unknown) => Promise<unknown>;

	try {
		return { result: await handler({ request, locals: { user: { id: userId } } }) };
	} catch (thrown) {
		return { thrown };
	}
}

beforeAll(async () => {
	execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
		env: process.env,
		stdio: "ignore",
	});

	({ actions } = await import("./+page.server"));
	({ prisma } = await import("$lib/server/prisma"));
}, 60_000);

afterAll(async () => {
	await prisma?.$disconnect();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.user.deleteMany();

	({ id: userId } = await prisma.user.create({
		data: { email: "host@example.test", passwordHash: "x", name: "Host" },
	}));
});

describe("create action", () => {
	it("creates the event with the default appearance when no appearance fields are posted", async () => {
		const { result, thrown } = await create(collapsedForm);

		expect(result).toBeUndefined();
		expect(thrown).toMatchObject({ status: 303 });

		const event = await prisma.event.findFirstOrThrow({ where: { userId } });

		expect(thrown).toMatchObject({ location: `/event/manage/${event.manageToken}?new` });

		expect(event).toMatchObject({
			title: "Garden party",
			theme: "light",
			primaryColor: null,
			secondaryColor: null,
			backgroundImage: null,
			emoji: null,
		});

		expect(eventTheme(event).themeVars).toEqual(
			eventTheme({ primaryColor: "violet", secondaryColor: "pink", backgroundImage: null })
				.themeVars,
		);
	});

	it("keeps the appearance the host picked", async () => {
		await create({
			...collapsedForm,
			primaryColor: "teal",
			secondaryColor: "amber",
			emoji: "🎉",
			backgroundImage: "",
		});

		const event = await prisma.event.findFirstOrThrow({ where: { userId } });

		expect(event).toMatchObject({ primaryColor: "teal", secondaryColor: "amber", emoji: "🎉" });
	});
});
