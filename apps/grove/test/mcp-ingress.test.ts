import * as PgClient from "@effect/sql-pg/PgClient";
import type { ApiServer } from "@petalnet/effect-api";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	ActorAuthority,
	ActorAuthorityLayer,
	ActorDatabaseError,
	type PersonPrincipal,
} from "../src/lib/server/actors/authority";
import { groveApi } from "../src/lib/server/api";
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
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_META = {
	"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
	"io.modelcontextprotocol/clientInfo": { name: "grove-ingress-test", version: "1.0.0" },
	"io.modelcontextprotocol/clientCapabilities": {},
};
const rpc = (id: number, method: string, params?: object) =>
	JSON.stringify({
		jsonrpc: "2.0",
		id,
		method,
		params: { ...params, _meta: MCP_META },
	});
interface McpJson {
	readonly result: {
		readonly resultType: string;
		readonly supportedVersions: readonly string[];
		readonly ttlMs: number;
		readonly cacheScope: string;
		readonly tools: readonly { readonly name: string }[];
		readonly isError: boolean;
		readonly structuredContent: Record<string, unknown>;
	};
	readonly error: { readonly code: number };
}
const responseJson = (response: Response): Promise<unknown> => response.json() as Promise<unknown>;
const json = async (response: Response) => (await responseJson(response)) as McpJson;

describe("MCP protected-resource ingress", () => {
	let runtime: ManagedRuntime.ManagedRuntime<ActorAuthority | SproutCommands | ApiServer, unknown>;
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
		runtime = ManagedRuntime.make(Layer.merge(domain, groveApi.layer));

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
		standardHeaders = true,
	) => {
		const headers = new Headers(extraHeaders);
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
		if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
		if (standardHeaders) {
			try {
				const parsed = JSON.parse(body) as {
					readonly method?: unknown;
					readonly params?: { readonly name?: unknown };
				};
				if (typeof parsed.method === "string" && !headers.has("mcp-method"))
					headers.set("mcp-method", parsed.method);
				if (typeof parsed.params?.name === "string" && !headers.has("mcp-name"))
					headers.set("mcp-name", parsed.params.name);
			} catch {
				// Ingress parse-error tests deliberately send malformed JSON.
			}
			if (!headers.has("mcp-protocol-version"))
				headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
		}
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

	it("serves modern discovery and lets Effect enforce the modern request envelope", async () => {
		const accessToken = await token("modern-discovery", ["grove:mcp"]);
		const discovered = await json(await request(accessToken, rpc(20, "server/discover")));
		expect(discovered.result).toMatchObject({
			resultType: "complete",
			supportedVersions: [MCP_PROTOCOL_VERSION],
			ttlMs: 0,
			cacheScope: "private",
		});
		// Capabilities describe the shared server; tool discovery remains caller-specific.
		expect(discovered.result).toHaveProperty("capabilities.tools");
		expect((await json(await request(accessToken, rpc(21, "tools/list")))).result.tools).toEqual(
			[],
		);

		const missingVersion = await request(
			accessToken,
			rpc(21, "tools/list"),
			undefined,
			ingress,
			false,
		);
		expect(missingVersion.status).toBe(400);
		expect(await json(missingVersion)).toMatchObject({ error: { code: -32020 } });

		const unknownMethod = await request(accessToken, rpc(23, "grove/not-a-method"));
		expect(unknownMethod.status).toBe(404);
		expect(await json(unknownMethod)).toMatchObject({ error: { code: -32601 } });
	});

	it("rejects legacy initialization on the July-only endpoint", async () => {
		const accessToken = await token("legacy-fallback", ["grove:mcp"]);
		const response = await request(
			accessToken,
			JSON.stringify({
				jsonrpc: "2.0",
				id: 22,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "legacy-grove-test", version: "1.0.0" },
				},
			}),
			undefined,
			ingress,
			false,
		);
		expect(response.status).toBe(400);
		expect(await json(response)).toHaveProperty("error");
	});

	it("restricts bootstrap visibility, explicitly enrolls, and keeps retries idempotent", async () => {
		const accessToken = await token("janet-machine", ["grove:mcp", "grove:agent:enroll"]);
		const listedBefore = await json(await request(accessToken, rpc(1, "tools/list")));
		expect(listedBefore.result).toMatchObject({
			resultType: "complete",
			ttlMs: 0,
			cacheScope: "private",
		});
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
			resultType: "complete",
			isError: false,
			structuredContent: { kind: "agent", name: "Janet", homeHostId: "host-local" },
		});
		expect(enrolled.result.structuredContent).toEqual({
			kind: "agent",
			actorId: expect.any(String) as unknown,
			name: "Janet",
			homeHostId: "host-local",
			ownerPersonId: owner.actorId,
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

		const unscopedRetry = await json(
			await request(
				await token("janet-machine", ["grove:mcp"]),
				rpc(15, "tools/call", { name: "agents.enrollSelf", arguments: { name: "Denied retry" } }),
			),
		);
		expect(unscopedRetry).toMatchObject({ error: { code: -32602 } });
		expect(unscopedRetry).not.toHaveProperty("result");

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

	it("requires the MCP JSON media type", async () => {
		const accessToken = await token("wrong-media-type", ["grove:mcp"]);
		const response = await request(accessToken, rpc(14, "tools/list"), {
			"content-type": "text/plain",
		});

		expect(response.status).toBe(415);
		expect(await responseJson(response)).toEqual({
			error: "unsupported_media_type",
			message: "MCP requests must use application/json",
		});
	});

	it("rejects an MCP body that exceeds one MiB", async () => {
		const accessToken = await token("oversized-body", ["grove:mcp"]);
		const response = await request(
			accessToken,
			JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
		);

		expect(response.status).toBe(413);
		expect(await responseJson(response)).toEqual({
			error: "request_too_large",
			message: "MCP requests must not exceed 1 MiB",
		});
	});

	it("cancels a pending body read on request interruption", async () => {
		const accessToken = await token("interrupted-body", ["grove:mcp"]);
		const pulled = Promise.withResolvers<undefined>();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					pulled.resolve(undefined);
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		const controller = new AbortController();
		const incoming = new Request(`${config.resourceOrigin}/mcp`, {
			method: "POST",
			headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit);
		const pending = runtime.runPromiseExit(ingress.handle(incoming), { signal: controller.signal });
		await pulled.promise;
		controller.abort();
		const exit = await pending;
		expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("bounds streamed bytes, cancels overflow, and rejects invalid UTF-8", async () => {
		const accessToken = await token("stream-boundary", ["grove:mcp"]);
		const encoder = new TextEncoder();
		const raw = rpc(16, "tools/list", { padding: "é" });
		const encoded = encoder.encode(raw);
		const atLimit = encoder.encode(raw + " ".repeat(1024 * 1024 - encoded.byteLength));
		const split = encoded.indexOf(0xc3) + 1;
		const cases = [
			{
				chunks: [atLimit.subarray(0, split), atLimit.subarray(split)],
				length: undefined,
				status: 200,
			},
			{ chunks: [atLimit, encoder.encode(" ")], length: undefined, status: 413 },
			{ chunks: [atLimit, encoder.encode(" ")], length: "1", status: 413 },
			{ chunks: [new Uint8Array([0xc3, 0x28])], length: undefined, status: 400 },
		];
		await Promise.all(
			cases.map(async ({ chunks, length, status }) => {
				const cancel = vi.fn();
				let index = 0;
				const body = new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							const chunk = chunks.at(index++);
							if (chunk) controller.enqueue(chunk);
							else controller.close();
						},
						cancel,
					},
					{ highWaterMark: 0 },
				);
				const headers = new Headers({
					authorization: `Bearer ${accessToken}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": MCP_PROTOCOL_VERSION,
					"mcp-method": "tools/list",
				});
				if (length) headers.set("content-length", length);
				const incoming = new Request(`${config.resourceOrigin}/mcp`, {
					method: "POST",
					headers,
					body,
					duplex: "half",
				} as RequestInit);
				const response = await runtime.runPromise(ingress.handle(incoming));
				expect(response.status).toBe(status);
				if (status === 200) expect(await json(response)).toMatchObject({ result: { tools: [] } });
				if (status === 400) expect(await json(response)).toMatchObject({ error: { code: -32700 } });
				if (status === 413) {
					expect(await responseJson(response)).toMatchObject({ error: "request_too_large" });
					expect(cancel).toHaveBeenCalledOnce();
				} else expect(cancel).not.toHaveBeenCalled();
			}),
		);
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
			).pipe(Layer.merge(groveApi.layer)),
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
