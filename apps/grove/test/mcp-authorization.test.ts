import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AuthenticationRequired } from "../src/lib/server/authorization";
import { handleMcpRequest } from "../src/lib/server/sprouts/mcp";
import { SproutServiceBuildLayer } from "../src/lib/server/sprouts/service";

describe("handleMcpRequest", () => {
	it("rejects unauthenticated JSON-RPC at the HTTP boundary", async () => {
		const event = {
			locals: {
				mcpPrincipal: null,
				session: { id: "browser-session" },
				user: { id: "browser-user" },
			},
			request: new Request("https://grove.test/mcp", {
				method: "POST",
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		} as RequestEvent;
		const error = await handleMcpRequest(event.request).pipe(
			Effect.provide(SproutServiceBuildLayer),
			Effect.provideService(SvelteKitRequestEvent, event),
			Effect.flip,
			Effect.runPromise,
		);

		expect(error).toBeInstanceOf(AuthenticationRequired);
	});

	it("dispatches a tool request only with a bearer-token principal", async () => {
		const request = new Request("https://grove.test/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		const event = {
			locals: {
				mcpPrincipal: { subject: "mcp-client-user", scopes: new Set(["grove:mcp"]) },
				session: null,
				user: null,
			},
			request,
		} as unknown as RequestEvent;
		const response = await handleMcpRequest(request).pipe(
			Effect.provide(SproutServiceBuildLayer),
			Effect.provideService(SvelteKitRequestEvent, event),
			Effect.runPromise,
		);

		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		expect(body).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
		});
		expect(body).toHaveProperty("result.tools");
	});
});
