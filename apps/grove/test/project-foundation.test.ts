import { SvelteKitRequestEvent } from "@petalnet/effect-sveltekit";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AuthenticationRequired, requireGrovePrincipal } from "../src/lib/server/authorization";
import { groveApi } from "../src/lib/server/grove/api";
import { canonicalDigest, canonicalJson } from "../src/lib/server/projects/canonical";
import { ProjectServiceBuildLayer } from "../src/lib/server/projects/service";
import { SproutServiceBuildLayer } from "../src/lib/server/sprouts/service";

const event = (pathname: string, locals: Partial<App.Locals>) =>
	({
		url: new URL(`https://grove.test${pathname}`),
		locals: { mcpPrincipal: null, session: null, user: null, ...locals },
	}) as RequestEvent;

describe("Grove project foundation", () => {
	it("canonicalizes nested object keys and produces deterministic SHA-256 digests", () => {
		const left = { z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } };
		const right = { a: { c: 3, d: 4 }, z: [{ a: 1, b: 2 }] };
		expect(canonicalJson(left)).toBe('{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}');
		expect(canonicalDigest(left)).toBe(canonicalDigest(right));
		expect(canonicalDigest(left)).toMatch(/^[a-f\d]{64}$/);
	});

	it("selects server-derived human and MCP principals without cookie fallback on MCP", async () => {
		const human = await requireGrovePrincipal.pipe(
			Effect.provideService(
				SvelteKitRequestEvent,
				event("/api/v1/projects", { user: { id: "human" } as App.Locals["user"] }),
			),
			Effect.runPromise,
		);
		expect(human).toEqual({ id: "human", kind: "human" });

		const mcp = await requireGrovePrincipal.pipe(
			Effect.provideService(
				SvelteKitRequestEvent,
				event("/mcp", {
					mcpPrincipal: { subject: "agent", scopes: new Set(["grove:mcp"]) },
					user: { id: "cookie" } as App.Locals["user"],
				}),
			),
			Effect.runPromise,
		);
		expect(mcp).toEqual({ id: "agent", kind: "mcp" });

		const rejected = await requireGrovePrincipal.pipe(
			Effect.provideService(
				SvelteKitRequestEvent,
				event("/mcp", { user: { id: "cookie" } as App.Locals["user"] }),
			),
			Effect.flip,
			Effect.runPromise,
		);
		expect(rejected).toBeInstanceOf(AuthenticationRequired);
	});

	it("discovers project.create through OpenAPI and MCP", async () => {
		expect(JSON.stringify(groveApi.openapi)).toContain("project.create");
		const response = await groveApi
			.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })
			.pipe(
				Effect.provide(ProjectServiceBuildLayer),
				Effect.provide(SproutServiceBuildLayer),
				Effect.provideService(SvelteKitRequestEvent, event("/mcp", {})),
				Effect.runPromise,
			);
		expect(JSON.stringify(await response.json())).toContain("project.create");
	});
});
