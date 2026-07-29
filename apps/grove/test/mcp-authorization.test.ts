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
			locals: { session: null, user: null },
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
});
