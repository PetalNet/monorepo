import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { InvocationContext, withRestInvocation } from "../src/lib/server/invocation";

const eventFor = (actor: App.Locals["actor"]) => {
	const request = new Request("https://grove.example/api/v1/sprouts");
	return {
		request,
		url: new URL(request.url),
		locals: { actor, session: null, user: null },
	} as RequestEvent;
};

describe("REST invocation", () => {
	it("keeps unauthenticated failures in the REST error envelope", async () => {
		const response = await Effect.runPromise(
			withRestInvocation(Effect.succeed(new Response("unreachable"))).pipe(
				Effect.provideService(SvelteKitRequestEvent, eventFor(null)),
			),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: "operation_failed", message: "Authentication required" },
		});
	});

	it("stamps the browser actor as a REST invocation", async () => {
		const actor = {
			kind: "person" as const,
			actorId: "person-rest",
			authUserId: "auth-rest",
			name: "REST Person",
		};
		const response = await Effect.runPromise(
			withRestInvocation(
				Effect.map(InvocationContext, (invocation) => Response.json(invocation)),
			).pipe(Effect.provideService(SvelteKitRequestEvent, eventFor(actor))),
		);

		expect(await response.json()).toMatchObject({ principal: actor, transport: "rest" });
	});
});
