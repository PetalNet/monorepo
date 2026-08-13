import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth", () => ({ GroveAuth: {} }));
vi.mock("$lib/server/runtime", () => ({
	runGrove: () => {
		throw new Error("A disabled development route must not enter the Grove runtime");
	},
}));

import { GET as getIndex } from "../src/routes/__dev/+server";
import { GET as getLogin } from "../src/routes/__dev/log-me-in/operator/+server";
import { GET as getLogout } from "../src/routes/__dev/log-me-out/+server";

const originalFlag = process.env.GROVE_ORB_DEV_AUTH;
const eventFor = <Event extends RequestEvent>(path: string) => {
	const url = new URL(path, "https://grove.test");
	return {
		request: new Request(url),
		url,
	} as Event;
};

afterEach(() => {
	if (originalFlag === undefined) delete process.env.GROVE_ORB_DEV_AUTH;
	else process.env.GROVE_ORB_DEV_AUTH = originalFlag;
});

describe("Grove development routes", () => {
	it("return 404 when the explicit development auth flag is absent", async () => {
		delete process.env.GROVE_ORB_DEV_AUTH;

		const responses = await Promise.all([
			getIndex(eventFor<Parameters<typeof getIndex>[0]>("/__dev")),
			getLogin(eventFor<Parameters<typeof getLogin>[0]>("/__dev/log-me-in/operator?returnTo=/")),
			getLogout(eventFor<Parameters<typeof getLogout>[0]>("/__dev/log-me-out?returnTo=/")),
		]);

		expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
	});

	it("serves the machine-readable inventory only when explicitly enabled", async () => {
		process.env.GROVE_ORB_DEV_AUTH = "1";

		const response = await getIndex(eventFor<Parameters<typeof getIndex>[0]>("/__dev"));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		await expect(response.json()).resolves.toMatchObject({ status: "development-only" });
	});
});
