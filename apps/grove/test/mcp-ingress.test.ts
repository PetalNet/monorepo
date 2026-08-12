import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ActorAuthority,
	ActorAuthorityLayer,
	ActorDatabaseError,
	type PersonPrincipal,
} from "../src/lib/server/actors/authority";
import { InvocationContext } from "../src/lib/server/invocation";
import { makeMcpIngress, type McpIngress } from "../src/lib/server/mcp/ingress";
import { SproutCommands, SproutCommandsLayer } from "../src/lib/server/sprouts/service";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

const config = {
	issuer: "https://machine.example/issuer",
	jwksUrl: "https://machine.example/jwks",
	resourceOrigin: "https://grove.example",
};
const ownerIdentity = {
	issuer: "https://identity.example/realms/grove",
	subject: "operator-1",
};
const rpc = (id: number, method: string, params?: object) =>
	JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
interface McpJson {
	readonly result: {
		readonly tools: readonly { readonly name: string }[];
		readonly isError: boolean;
		readonly structuredContent: Record<string, unknown>;
	};
	readonly error: { readonly code: number };
}
const responseJson = (response: Response): Promise<unknown> => response.json() as Promise<unknown>;
const json = async (response: Response) => (await responseJson(response)) as McpJson;

describe("MCP protected-resource ingress", () => {
	let runtime: ManagedRuntime.ManagedRuntime<ActorAuthority | SproutCommands, unknown>;
	let ingress: McpIngress;
	let privateKey: CryptoKey;
	let owner: PersonPrincipal;

	beforeAll(async () => {
		const postgres = await startGrovePostgres();
		const database = PgClient.layer({ url: Redacted.make(postgres.databaseUrl) });
		const actors = ActorAuthorityLayer({ homeOwner: ownerIdentity }).pipe(
			Layer.provideMerge(database),
		);
		const domain = SproutCommandsLayer.pipe(Layer.provideMerge(actors));
		runtime = ManagedRuntime.make(domain);

		owner = await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) =>
				authority.bindBrowserIdentity({
					authUserId: "auth-owner",
					...ownerIdentity,
					name: "Grove Operator",
					emailVerified: true,
				}),
			),
		);

		const pair = await generateKeyPair("RS256");
		privateKey = pair.privateKey;
		const jwk = { ...(await exportJWK(pair.publicKey)), kid: "mcp-test", alg: "RS256", use: "sig" };
		ingress = makeMcpIngress(config, createLocalJWKSet({ keys: [jwk] }));
	}, 60_000);

	afterAll(async () => {
		await runtime.dispose();
		await stopGrovePostgres();
	});

	const token = (subject: string, scopes: readonly string[], kid = "mcp-test") => {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({ scope: scopes.join(" ") })
			.setProtectedHeader({ alg: "RS256", kid })
			.setIssuer(config.issuer)
			.setAudience(`${config.resourceOrigin}/mcp`)
			.setSubject(subject)
			.setIssuedAt(now)
			.setExpirationTime(now + 300)
			.sign(privateKey);
	};
	const request = async (
		accessToken: string | undefined,
		body: string,
		extraHeaders?: HeadersInit,
		target = ingress,
	) => {
		const headers = new Headers(extraHeaders);
		headers.set("content-type", "application/json");
		if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
		return runtime.runPromise(
			target.handle(
				new Request(`${config.resourceOrigin}/mcp`, {
					method: "POST",
					headers,
					body,
				}),
			),
		);
	};
	it("publishes the existing RFC 9728 resource metadata", () => {
		expect(ingress.metadata()).toEqual({
			resource: "https://grove.example/mcp",
			authorization_servers: [config.issuer],
			bearer_methods_supported: ["header"],
			scopes_supported: ["grove:mcp", "grove:agent:enroll"],
		});
	});

	it("rejects invalid protected-resource configuration during construction", () => {
		expect(() =>
			makeMcpIngress({
				...config,
				resourceOrigin: "https://grove.example/not-an-origin",
			}),
		).toThrow("GROVE_MCP_RESOURCE must be a canonical origin");
	});

	it("uses bearer identity only and challenges cookie-only requests", async () => {
		const response = await request(undefined, rpc(1, "tools/list"), {
			cookie: "better-auth.session_token=browser-session",
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
	});

	it("restricts bootstrap visibility, explicitly enrolls, and keeps retries idempotent", async () => {
		const accessToken = await token("janet-machine", ["grove:mcp", "grove:agent:enroll"]);
		const listedBefore = await json(await request(accessToken, rpc(1, "tools/list")));
		expect(listedBefore.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"agents.enrollSelf",
		]);

		const enrolled = await json(
			await request(
				accessToken,
				rpc(2, "tools/call", {
					name: "agents.enrollSelf",
					arguments: { name: "Janet" },
				}),
			),
		);
		expect(enrolled.result).toMatchObject({
			isError: false,
			structuredContent: { kind: "agent", name: "Janet", homeHostId: "host-local" },
		});
		const agentId = enrolled.result.structuredContent.actorId as string;

		const repeated = await json(
			await request(
				accessToken,
				rpc(3, "tools/call", {
					name: "agents.enrollSelf",
					arguments: { name: "Ignored retry name" },
				}),
			),
		);
		expect(repeated.result.structuredContent.actorId).toBe(agentId);

		const listedAfter = await json(await request(accessToken, rpc(4, "tools/list")));
		expect(listedAfter.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"sprouts.create",
			"sprouts.get",
			"sprouts.list",
			"sprouts.remove",
			"sprouts.water",
		]);
	});

	it("executes bearer-only tools/call and never confuses an attached browser cookie for the actor", async () => {
		const accessToken = await token("janet-machine", ["grove:mcp", "grove:agent:enroll"]);
		const created = await json(
			await request(
				accessToken,
				rpc(5, "tools/call", {
					name: "sprouts.create",
					arguments: { name: "Bearer-grown fern" },
				}),
				{ cookie: "better-auth.session_token=owner-browser-session" },
			),
		);
		expect(created.result).toMatchObject({
			isError: false,
			structuredContent: {
				name: "Bearer-grown fern",
			},
		});
		const createdBy = created.result.structuredContent.createdByActorId;
		const lastActor = created.result.structuredContent.lastActorId;
		expect(createdBy).toEqual(expect.any(String));
		expect(lastActor).toEqual(expect.any(String));
		if (typeof createdBy !== "string" || typeof lastActor !== "string")
			throw new TypeError("Expected Agent actor IDs");
		expect(createdBy).toMatch(/^agent-/);
		expect(lastActor).toBe(createdBy);

		const listedForBrowserActor = await runtime.runPromise(
			Effect.flatMap(SproutCommands, (commands) => commands.list).pipe(
				Effect.provideService(InvocationContext, {
					principal: owner,
					transport: "browser",
					requestId: "browser-parity",
				}),
			),
		);
		expect(listedForBrowserActor).toEqual(
			expect.arrayContaining([expect.objectContaining(created.result.structuredContent)]),
		);
	});

	it("reauthorizes enrollment retries after Agent suspension", async () => {
		const accessToken = await token("revoked-machine", ["grove:mcp", "grove:agent:enroll"]);
		const enrolled = await json(
			await request(
				accessToken,
				rpc(10, "tools/call", {
					name: "agents.enrollSelf",
					arguments: { name: "Soon suspended" },
				}),
			),
		);
		const agentId = enrolled.result.structuredContent.actorId as string;
		await runtime.runPromise(
			Effect.flatMap(ActorAuthority, (authority) => authority.suspendAgentAs(owner, agentId)),
		);

		const retried = await json(
			await request(
				accessToken,
				rpc(11, "tools/call", {
					name: "agents.enrollSelf",
					arguments: { name: "Must stay suspended" },
				}),
			),
		);
		expect(retried.result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: "operation_failed" } },
		});
	});

	it("shows no ordinary tools to an unbound identity without enrollment scope", async () => {
		const accessToken = await token("unapproved-machine", ["grove:mcp"]);
		const listed = await json(await request(accessToken, rpc(6, "tools/list")));

		expect(listed.result.tools).toEqual([]);
	});

	it("returns a parse error without entering command dispatch", async () => {
		const accessToken = await token("janet-machine", ["grove:mcp", "grove:agent:enroll"]);
		const response = await request(accessToken, "{");

		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({ error: { code: -32700 } });
	});

	it("distinguishes insufficient admission, unknown keys, and JWKS dependency failure", async () => {
		const insufficient = await request(
			await token("scope-missing", ["grove:agent:enroll"]),
			rpc(7, "tools/list"),
		);
		expect(insufficient.status).toBe(403);

		const unknownKid = await request(
			await token("unknown-key", ["grove:mcp"], "not-in-readable-jwks"),
			rpc(8, "tools/list"),
		);
		expect(unknownKid.status).toBe(401);

		const unavailable = makeMcpIngress(config, () => {
			throw new TypeError("simulated JWKS network failure");
		});
		const dependencyFailure = await request(
			await token("network-failure", ["grove:mcp"]),
			rpc(9, "tools/list"),
			undefined,
			unavailable,
		);
		expect(dependencyFailure.status).toBe(503);
		expect(await json(dependencyFailure)).toEqual({
			error: "identity_provider_unavailable",
			message: "MCP identity validation is unavailable",
		});

		const dependencyToken = await token("dependency-failure", ["grove:mcp"]);
		const failures = await Promise.all(
			[
				new errors.JWKSTimeout("simulated timeout"),
				new errors.JOSEError("simulated non-200 response"),
				new errors.JWKSInvalid("simulated malformed JWKS"),
			].map(async (error) => {
				const failedDependency = makeMcpIngress(config, () => {
					throw error;
				});
				const response = await request(
					dependencyToken,
					rpc(12, "tools/list"),
					undefined,
					failedDependency,
				);
				return { status: response.status, body: await json(response) };
			}),
		);
		for (const failure of failures) {
			expect(failure.status).toBe(503);
			expect(failure.body).toMatchObject({ error: "identity_provider_unavailable" });
		}
	});

	it("sanitizes actor-authority dependency failures at the ingress boundary", async () => {
		const authority = await runtime.runPromise(ActorAuthority);
		const commands = await runtime.runPromise(SproutCommands);
		const failingRuntime = ManagedRuntime.make(
			Layer.merge(
				Layer.succeed(ActorAuthority, {
					...authority,
					resolveMachineIdentity: () =>
						Effect.fail(new ActorDatabaseError(new Error("simulated database outage"))),
				}),
				Layer.succeed(SproutCommands, commands),
			),
		);
		try {
			const response = await failingRuntime.runPromise(
				ingress.handle(
					new Request(`${config.resourceOrigin}/mcp`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${await token("authority-failure", ["grove:mcp"])}`,
						},
						body: rpc(13, "tools/list"),
					}),
				),
			);
			expect(response.status).toBe(503);
			expect(await json(response)).toEqual({
				error: "authority_unavailable",
				message: "MCP actor resolution is unavailable",
			});
		} finally {
			await failingRuntime.dispose();
		}
	});
});
