import { operation } from "@petalnet/effect-api";
import { createServer } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { CurrentPrincipal } from "../src/lib/server/actors/authority";
import { authenticationErrors, browserAuthentication } from "../src/lib/server/authentication";
import { AuthenticationRequired } from "../src/lib/server/authorization";

const server = createServer({
	title: "Authentication",
	version: "1",
	basePath: "/api/v1",
	services: Layer.empty,
	auth: { browser: browserAuthentication, errors: authenticationErrors, mcp: false },
	operations: [
		operation({
			name: "principal",
			description: "Principal",
			method: "GET",
			path: "/projects",
			input: Schema.Struct({}),
			output: Schema.Unknown,
			handler: () => CurrentPrincipal,
		}),
		operation({
			name: "domain-failure",
			description: "Domain failure",
			method: "GET",
			path: "/domain-failure",
			input: Schema.Struct({}),
			output: Schema.Unknown,
			handler: () => Effect.fail(new AuthenticationRequired()),
			errors: { AuthenticationRequired: { status: 409, message: "Domain authentication failure" } },
		}),
	],
});

afterAll(() => server.dispose());

const eventFor = (actor: App.Locals["actor"], path = "/api/v1/projects") => {
	const request = new Request(`https://grove.example${path}`);

	return {
		request,
		url: new URL(request.url),
		locals: { actor, session: null, user: null },
	} as RequestEvent;
};

describe("Server authentication", () => {
	it("does not expose MCP or resource metadata when the transport is disabled", async () => {
		const responses = await Promise.all(
			["/mcp", "/.well-known/oauth-protected-resource/mcp"].map((path) =>
				server.http(eventFor(null, path)),
			),
		);

		for (const response of responses) {
			expect(response.status).toBe(404);
		}
	});

	it("allows remote queries whose request event hides URL access", async () => {
		const actor = {
			kind: "person" as const,
			actorId: "person-query",
			authUserId: "auth-query",
			name: "Query Person",
		};
		const event = eventFor(actor);

		Object.defineProperty(event, "url", {
			get: () => {
				throw new Error("Kit remote query hides event.url");
			},
		});

		const principal = await server.run(CurrentPrincipal, event);

		expect(principal).toEqual(actor);
	});

	it("keeps unauthenticated failures in the REST error envelope", async () => {
		const response = await server.http(eventFor(null));

		expect(response.status).toBe(401);

		expect(await response.json()).toEqual({
			error: { code: "operation_failed", message: "Authentication required" },
		});
	});

	it("provides the authenticated browser actor to REST operations", async () => {
		const actor = {
			kind: "person" as const,
			actorId: "person-rest",
			authUserId: "auth-rest",
			name: "REST Person",
		};
		const response = await server.http(eventFor(actor));

		expect(await response.json()).toEqual(actor);

		const downstreamFailure = new AuthenticationRequired();

		await expect(server.run(Effect.fail(downstreamFailure), eventFor(actor))).rejects.toMatchObject(
			{ status: 401, body: { message: "Authentication required" } },
		);

		const failed = await server.http(eventFor(actor, "/api/v1/domain-failure"));

		expect(failed.status).toBe(409);

		expect(await failed.json()).toEqual({
			error: { code: "operation_failed", message: "Domain authentication failure" },
		});
	});
});
