import type { RequestEvent } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth", () => ({ GroveAuth: {} }));
vi.mock("$lib/server/runtime", () => ({
	runGrove: () => {
		throw new Error("A disabled development route must not enter the Grove runtime");
	},
}));
vi.mock("$app/env/private", () => ({
	BETTER_AUTH_URL: "https://grove.test",
	GROVE_MCP_ISSUER: "https://oidc.test/realms/grove-mcp",
	GROVE_MCP_RESOURCE: "https://grove.test",
	GROVE_OIDC_ISSUER: "https://oidc.test/realms/grove",
}));
vi.mock("$lib/server/mcp-oauth-runtime", () => ({
	groveMcpProtectedResourceMetadata: () => ({
		resource: "https://grove.test/mcp",
		authorization_servers: ["https://oidc.test/realms/grove-mcp"],
		bearer_methods_supported: ["header"],
		scopes_supported: ["grove:mcp", "grove:agent:enroll"],
	}),
}));

import { GET as getProtectedResource } from "../src/routes/.well-known/oauth-protected-resource/mcp/+server";
import { GET as getIndex } from "../src/routes/__dev/+server";
import { GET as getLogin } from "../src/routes/__dev/log-me-in/operator/+server";
import { GET as getLogout } from "../src/routes/__dev/log-me-out/+server";
import { POST as postBrowserLogs } from "../src/routes/__dev/logs/browser/+server";
import { GET as getPreflight } from "../src/routes/__dev/preflight/+server";

const originalFlag = process.env.GROVE_ORB_DEV_AUTH;
const eventFor = <Route extends RequestEvent["route"]["id"]>(path: string, route: Route) => {
	const url = new URL(path, "https://grove.test");
	return {
		request: new Request(url),
		route: { id: route },
		url,
	} as RequestEvent<Record<string, never>, Route>;
};

afterEach(() => {
	if (originalFlag === undefined) delete process.env.GROVE_ORB_DEV_AUTH;
	else process.env.GROVE_ORB_DEV_AUTH = originalFlag;
});

describe("Grove development routes", () => {
	it("return 404 when the explicit development auth flag is absent", async () => {
		delete process.env.GROVE_ORB_DEV_AUTH;

		const responses = await Promise.all([
			getIndex(eventFor("/__dev", "/__dev")),
			getLogin(eventFor("/__dev/log-me-in/operator?returnTo=/", "/__dev/log-me-in/operator")),
			getLogout(eventFor("/__dev/log-me-out?returnTo=/", "/__dev/log-me-out")),
			postBrowserLogs(eventFor("/__dev/logs/browser", "/__dev/logs/browser")),
			getPreflight(eventFor("/__dev/preflight", "/__dev/preflight")),
		]);

		expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
	});

	it("serves the machine-readable inventory only when explicitly enabled", async () => {
		process.env.GROVE_ORB_DEV_AUTH = "1";

		const response = await getIndex(eventFor("http://grove.test/__dev", "/__dev"));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		await expect(response.json()).resolves.toMatchObject({
			status: "development-only",
			endpoints: {
				login: {
					href: "https://grove.test/__dev/log-me-in/operator?returnTo=/",
				},
			},
		});
	});

	it("serves MCP protected-resource discovery independently from browser auth", async () => {
		const response = await getProtectedResource(
			eventFor(
				"/.well-known/oauth-protected-resource/mcp",
				"/.well-known/oauth-protected-resource/mcp",
			),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			resource: "https://grove.test/mcp",
			authorization_servers: ["https://oidc.test/realms/grove-mcp"],
			bearer_methods_supported: ["header"],
			scopes_supported: ["grove:mcp", "grove:agent:enroll"],
		});
	});
});
