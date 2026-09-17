import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Schema,
	SchemaTransformation,
} from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
	ApiServer,
	createEffectApi as createApplication,
	type EffectApiConfig,
	operation,
} from "../src/index.js";

const disposals: (() => Promise<void>)[] = [];
afterAll(async () => {
	await Promise.all(disposals.map((dispose) => dispose()));
});

// Each application owns one runtime. Only invocation services cross this test bridge.
function createEffectApi<R>(config: EffectApiConfig<R>) {
	const application = createApplication(config);
	const runtime = ManagedRuntime.make(application.layer);
	disposals.push(() => runtime.dispose());
	const fetch = (...args: Parameters<typeof application.fetch>) =>
		Effect.gen(function* () {
			const services = yield* Effect.context<R>();
			const exit = yield* Effect.promise(() =>
				runtime.runPromiseExit(application.fetch(...args).pipe(Effect.provide(services))),
			);
			return yield* Exit.isSuccess(exit)
				? Effect.succeed(exit.value)
				: Effect.failCause(exit.cause);
		});
	return { ...application, fetch, mcp: fetch };
}

const Id = Schema.Struct({ id: Schema.String });
const Item = Schema.Struct({ id: Schema.String, ok: Schema.Boolean });
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_META = {
	"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
	"io.modelcontextprotocol/clientInfo": { name: "effect-api-test", version: "1.0.0" },
	"io.modelcontextprotocol/clientCapabilities": {},
};

const modernMcpRequest = (id: number, method: string, params: Record<string, unknown> = {}) => {
	const headers = new Headers({
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
		"mcp-protocol-version": MCP_PROTOCOL_VERSION,
		"mcp-method": method,
	});
	if (method === "tools/call" && typeof params.name === "string")
		headers.set("mcp-name", params.name);
	return new Request("https://effect-api.test/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params: { ...params, _meta: MCP_META },
		}),
	});
};

const legacyInitializeRequest = () =>
	new Request("https://effect-api.test/mcp", {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 99,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "legacy-test", version: "1.0.0" },
			},
		}),
	});

const api = createEffectApi({
	title: "Test API",
	version: "1.0.0",
	basePath: "/api/v1",
	operations: [
		operation({
			name: "items.get",
			description: "Get an item.",
			method: "GET",
			path: "/items/:id",
			input: Id,
			output: Item,
			handler: ({ id }) => Effect.succeed({ id, ok: true }),
		}),
	],
});

const runJson = async <E>(effect: Effect.Effect<Response, E>) => {
	const response = await Effect.runPromise(effect);
	return { response, body: (await response.json()) as unknown };
};

const operationForMethod = (method: "GET" | "POST", body?: boolean) =>
	operation({
		name: method,
		description: method,
		method,
		path: "/",
		...(body === undefined ? {} : { body }),
		input: Schema.Unknown,
		output: Schema.Unknown,
		handler: Effect.succeed,
	});

afterEach(() => vi.restoreAllMocks());

describe("createEffectApi", () => {
	it("builds and registers one server for concurrent REST/MCP calls and finalizes its persistent scope", async () => {
		const registration = vi.fn(() => "Shared operation");
		const finalized = vi.fn(() => undefined);
		const built = vi.fn();
		const Caller = Context.Service<string>("LifecycleCaller");
		const shared = createApplication({
			title: "Shared",
			version: "1",
			basePath: "/api",
			operations: [
				operation({
					name: "shared",
					description: "Shared",
					method: "GET",
					path: "/shared",
					input: Schema.Struct({}),
					output: Schema.String,
					handler: () => Caller,
				}),
			],
			mcpOperations: [
				{
					...operation({
						name: "shared",
						description: "Shared",
						method: "GET",
						path: "/shared",
						input: Schema.Struct({}),
						output: Schema.String,
						handler: () => Caller,
					}),
					get description() {
						return registration();
					},
				},
			],
		});
		const runtime = ManagedRuntime.make(
			shared.layer.pipe(
				Layer.tap(() =>
					Effect.gen(function* () {
						built();
						yield* Effect.addFinalizer(() => Effect.sync(finalized));
					}),
				),
			),
		);
		disposals.push(() => runtime.dispose());
		// Build with no Caller service: registration must not capture invocation dependencies.
		const server = await runtime.runPromise(ApiServer);
		const results = await Promise.all(
			["alice", "bob", "carol", "dave"].map(async (caller, i) => {
				const request =
					i % 2 === 0
						? new Request("https://x/api/shared")
						: modernMcpRequest(i, "tools/call", { name: "shared", arguments: {} });
				const response = await runtime.runPromise(
					shared.fetch(request).pipe(Effect.provideService(Caller, caller)),
				);
				return response.json() as Promise<unknown>;
			}),
		);
		expect(results).toMatchObject([
			"alice",
			{ result: { structuredContent: "bob" } },
			"carol",
			{ result: { structuredContent: "dave" } },
		]);
		expect(await runtime.runPromise(ApiServer)).toBe(server);
		expect(built).toHaveBeenCalledOnce();
		expect(registration).toHaveBeenCalledOnce();
		expect(finalized).not.toHaveBeenCalled();
		await runtime.dispose();
		expect(finalized).toHaveBeenCalledOnce();
	});

	it("isolates concurrent callers' catalog and invocation permissions without leaking defaults", async () => {
		const handler = vi.fn(() => Effect.succeed("ok"));
		const catalog = createEffectApi({
			title: "Catalog",
			version: "1",
			basePath: "/api",
			operations: [],
			mcpOperations: ["alpha", "beta"].map((name) =>
				operation({
					name,
					description: name,
					method: "GET",
					path: `/${name}`,
					input: Schema.Struct({}),
					output: Schema.String,
					handler,
				}),
			),
		});
		await Promise.all(
			["alpha", "beta"].map(async (name, i) => {
				const permissions = { listed: new Set([name]), callable: new Set([name]) };
				const listed = await runJson(catalog.mcp(modernMcpRequest(i, "tools/list"), permissions));
				expect(listed.body).toMatchObject({ result: { tools: [{ name }] } });
				expect((listed.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
				const denied = await runJson(
					catalog.mcp(
						modernMcpRequest(i + 2, "tools/call", {
							name: name === "alpha" ? "beta" : "alpha",
							arguments: {},
						}),
						permissions,
					),
				);
				expect(denied.body).toMatchObject({ error: { code: -32602 } });
				const allowed = await runJson(
					catalog.mcp(modernMcpRequest(i + 4, "tools/call", { name, arguments: {} }), permissions),
				);
				expect(allowed.body).toMatchObject({ result: { isError: false, structuredContent: "ok" } });
			}),
		);
		expect(handler).toHaveBeenCalledTimes(2);
		const unrestricted = await runJson(catalog.mcp(modernMcpRequest(7, "tools/list")));
		expect((unrestricted.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(2);
		const empty = await runJson(
			catalog.mcp(modernMcpRequest(8, "tools/list"), { listed: new Set(), callable: new Set() }),
		);
		expect(empty.body).toMatchObject({ result: { tools: [] } });
	});

	it("interrupts a delayed handler when its Web request is aborted", async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const finalized = vi.fn(() => undefined);
		const delayed = createEffectApi({
			title: "Abort",
			version: "1",
			basePath: "/api",
			operations: [
				operation({
					name: "delay",
					description: "delay",
					method: "GET",
					path: "/delay",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Effect.sync(finalized));
							started();
							return yield* Effect.never;
						}).pipe(Effect.scoped),
				}),
			],
		});
		const controller = new AbortController();
		const pending = Effect.runPromiseExit(
			delayed.fetch(new Request("https://x/api/delay", { signal: controller.signal })),
		);
		await ready;
		controller.abort();
		const exit = await pending;
		expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
		expect(finalized).toHaveBeenCalledOnce();
	});

	it("runs asynchronous input transforms once per REST/MCP invocation and sanitizes decoder defects", async () => {
		const decode = vi.fn((value: string) =>
			Effect.promise(async () => {
				await Promise.resolve();
				return Number(value);
			}),
		);
		const logCause = vi.fn();
		const transformed = createEffectApi({
			title: "Async",
			version: "1",
			basePath: "/api",
			logCause,
			operations: [
				operation({
					name: "async",
					description: "async",
					method: "POST",
					path: "/async",
					input: Schema.Struct({
						value: Schema.String.pipe(
							Schema.decodeTo(
								Schema.Number,
								SchemaTransformation.transformEffect({
									decode,
									encode: (value) => Effect.succeed(String(value)),
								}),
							),
						),
					}),
					output: Schema.Number,
					handler: ({ value }) => Effect.succeed(value * 2),
				}),
				operation({
					name: "defective",
					description: "defective",
					method: "POST",
					path: "/defective",
					input: Schema.Struct({
						value: Schema.String.pipe(
							Schema.decodeTo(
								Schema.String,
								SchemaTransformation.transformEffect<string, string>({
									decode: () => Effect.die("private-input-defect"),
									encode: Effect.succeed,
								}),
							),
						),
					}),
					output: Schema.Unknown,
					handler: Effect.succeed,
				}),
			],
		});
		const rest = await runJson(
			transformed.fetch(
				new Request("https://x/api/async", {
					method: "POST",
					body: JSON.stringify({ value: "21" }),
				}),
			),
		);
		expect(rest.body).toBe(42);
		expect(decode).toHaveBeenCalledOnce();
		const mcp = await runJson(
			transformed.mcp(
				modernMcpRequest(1, "tools/call", { name: "async", arguments: { value: "21" } }),
			),
		);
		expect(mcp.body).toMatchObject({ result: { structuredContent: 42, isError: false } });
		expect(decode).toHaveBeenCalledTimes(2);
		const failures = await Promise.all([
			runJson(
				transformed.fetch(
					new Request("https://x/api/defective", {
						method: "POST",
						body: JSON.stringify({ value: "secret" }),
					}),
				),
			),
			runJson(
				transformed.mcp(
					modernMcpRequest(2, "tools/call", { name: "defective", arguments: { value: "secret" } }),
				),
			),
		]);
		expect(failures[0]).toMatchObject({
			response: { status: 500 },
			body: { error: { code: "operation_failed" } },
		});
		expect(failures[1].body).toMatchObject({
			result: { isError: true, structuredContent: { error: { code: "operation_failed" } } },
		});
		expect(JSON.stringify(failures)).not.toContain("private-input-defect");
		expect(logCause).toHaveBeenCalledTimes(2);
	});

	it("serves MCP independently without reading REST publication metadata", async () => {
		const { mcp } = createEffectApi({
			title: "MCP only",
			version: "1",
			basePath: "/api",
			operations: [],
			mcpOperations: [
				{
					...operation({
						name: "items.get",
						description: "Get an item",
						method: "GET",
						path: "/items/:id",
						input: Id,
						output: Item,
						handler: ({ id }) => Effect.succeed({ id, ok: true }),
					}),
					get path(): string {
						throw new Error("MCP must not construct REST or OpenAPI");
					},
				},
			],
		});
		const result = await runJson(
			mcp(
				modernMcpRequest(1, "tools/call", {
					name: "items.get",
					arguments: { id: "standalone" },
				}),
			),
		);
		expect(result.body).toMatchObject({
			result: { isError: false, structuredContent: { id: "standalone", ok: true } },
		});
	});

	it("keeps call-only tools out of discovery and validates routing before invoking them", async () => {
		const handler = vi.fn(() => Effect.succeed({ error: { code: -32700 } }));
		const application = createEffectApi({
			title: "Call only",
			version: "1",
			basePath: "/api",
			operations: [],
			mcpOperations: [
				operation({
					name: "items.retry",
					description: "Retry",
					method: "POST",
					path: "/retry",
					input: Id,
					output: Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) }),
					handler,
				}),
			],
		});
		const mcp = (request: Request | HttpServerRequest.HttpServerRequest) =>
			application.mcp(request, {
				listed: new Set(),
				callable: new Set(["items.retry"]),
			});
		const listed = await runJson(mcp(modernMcpRequest(1, "tools/list")));
		expect(listed.body).toMatchObject({ result: { tools: [] } });
		const forgedList = modernMcpRequest(2, "tools/list");
		forgedList.headers.set("mcp-method", "tools/call");
		forgedList.headers.set("mcp-name", "items.retry");
		expect((await runJson(mcp(forgedList))).response.status).toBe(400);
		const forgedCall = modernMcpRequest(3, "tools/call", {
			name: "items.retry",
			arguments: { id: "retry" },
		});
		forgedCall.headers.set("mcp-name", "items.other");
		expect((await runJson(mcp(forgedCall))).response.status).toBe(400);
		expect(handler).not.toHaveBeenCalled();

		const called = await runJson(
			mcp(
				HttpServerRequest.fromWeb(
					modernMcpRequest(4, "tools/call", { name: "items.retry", arguments: { id: "retry" } }),
				),
			),
		);
		// An error-shaped tool result is not a protocol parse failure.
		expect(called.response.status).toBe(200);
		expect(called.body).toMatchObject({
			result: { isError: false, structuredContent: { error: { code: -32700 } } },
		});
		expect(handler).toHaveBeenCalledExactlyOnceWith({ id: "retry" });
	});

	it("routes REST requests through the declared Effect operation", async () => {
		const response = await Effect.runPromise(
			api.fetch(new Request("https://grove.test/api/v1/items/example")),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ id: "example", ok: true });
	});

	it("applies body defaults and explicit overrides", () => {
		expect(operationForMethod("GET").body).toBe(false);
		expect(operationForMethod("POST").body).toBe(true);
		expect(operationForMethod("POST", false).body).toBe(false);
	});

	it("merges query, JSON object, and decoded path fields with path taking precedence", async () => {
		const echo = createEffectApi({
			title: "Echo",
			version: "1",
			basePath: "/api",
			operations: [
				operation({
					name: "echo",
					description: "echo",
					method: "POST",
					path: "/:id",
					input: Schema.Unknown,
					output: Schema.Unknown,
					handler: Effect.succeed,
				}),
			],
		});
		const { body } = await runJson(
			echo.fetch(
				new Request("https://x/api/a%20b?id=query&q=yes", {
					method: "POST",
					body: JSON.stringify({ id: "body", from: "body" }),
				}),
			),
		);
		expect(body).toEqual({ id: "a b", from: "body", q: "yes" });
	});

	it("handles root/base paths, query inputs, method mismatches, and missing routes", async () => {
		const root = createEffectApi({
			title: "Root",
			version: "1",
			basePath: "/api",
			operations: [
				operation({
					name: "root",
					description: "root",
					method: "DELETE",
					path: "/",
					input: Schema.Unknown,
					output: Schema.Unknown,
					handler: Effect.succeed,
				}),
			],
		});
		expect(
			(await runJson(root.fetch(new Request("https://x/api?a=1", { method: "DELETE" })))).body,
		).toEqual({ a: "1" });
		expect(
			(await runJson(root.fetch(new Request("https://x/", { method: "DELETE" })))).response.status,
		).toBe(404);
		const missing = await Promise.all(
			[
				new Request("https://x/api", { method: "POST" }),
				new Request("https://x/api/nope", { method: "DELETE" }),
			].map((request) => runJson(root.fetch(request))),
		);
		for (const result of missing) {
			expect(result).toMatchObject({
				response: { status: 404 },
				body: { error: { code: "not_found" } },
			});
		}
	});

	it("distinguishes empty, object, primitive, malformed, and schema-invalid JSON", async () => {
		const inputs: unknown[] = [];
		const bodyApi = createEffectApi({
			title: "Body",
			version: "1",
			basePath: "/",
			operations: [
				operation({
					name: "body",
					description: "body",
					method: "POST",
					path: "/body/:id",
					input: Schema.Unknown,
					output: Schema.Unknown,
					handler: (value) => {
						inputs.push(value);
						return Effect.succeed(value);
					},
				}),
			],
		});
		const bodyCases = [
			[undefined, { q: "1", id: "p" }],
			['{"x":1}', { x: 1, q: "1", id: "p" }],
			["7", 7],
		] as const;
		const bodyResults = await Promise.all(
			bodyCases.map(([body]) =>
				runJson(
					bodyApi.fetch(
						new Request("https://x/body/p?q=1", {
							method: "POST",
							...(body ? { body } : {}),
						}),
					),
				),
			),
		);
		for (const [index, result] of bodyResults.entries()) {
			const expected = bodyCases[index]?.[1];
			expect(result.body).toEqual(expected);
		}
		const malformed = await runJson(
			bodyApi.fetch(new Request("https://x/body/p", { method: "POST", body: "{" })),
		);
		expect(malformed).toMatchObject({
			response: { status: 400 },
			body: { error: { code: "invalid_json", message: "Expected a JSON body" } },
		});
		expect(inputs).toHaveLength(3);
		const invalid = await runJson(api.fetch(new Request("https://x/api/v1/items/ok?extra=x")));
		expect(invalid.response.status).toBe(200);
		const missing = await runJson(api.fetch(new Request("https://x/api/v1/items/")));
		expect(missing.response.status).toBe(404);
		const schemaApi = createEffectApi({
			title: "S",
			version: "1",
			basePath: "/",
			operations: [
				operation({
					name: "s",
					description: "s",
					method: "POST",
					path: "/s",
					input: Id,
					output: Schema.Unknown,
					handler: Effect.succeed,
				}),
			],
		});
		const bad = await runJson(
			schemaApi.fetch(new Request("https://x/s", { method: "POST", body: "{}" })),
		);
		expect(bad.response.status).toBe(400);
		expect(JSON.stringify(bad.body)).toContain("invalid_input");
		expect(JSON.stringify(bad.body)).toContain("id");
	});

	it("supplies handler Effect requirements", async () => {
		const Prefix = Context.Service<string>("Prefix");
		const serviced = createEffectApi({
			title: "S",
			version: "1",
			basePath: "/",
			operations: [
				operation({
					name: "service",
					description: "service",
					method: "GET",
					path: "/service/:id",
					input: Id,
					output: Schema.String,
					handler: ({ id }) => Effect.map(Prefix, (prefix) => prefix + id),
				}),
			],
		});
		const result = await Effect.runPromise(
			serviced.fetch(new Request("https://x/service/a")).pipe(Effect.provideService(Prefix, "#")),
		);
		await expect(result.json()).resolves.toBe("#a");

		const mcpResult = await Effect.runPromise(
			serviced
				.mcp(modernMcpRequest(1, "tools/call", { name: "service", arguments: { id: "a" } }))
				.pipe(Effect.provideService(Prefix, "#")),
		);
		await expect(mcpResult.json()).resolves.toMatchObject({
			result: { resultType: "complete", structuredContent: "#a", isError: false },
		});
		const concurrent = await Promise.all(
			["alice:", "bob:"].map(async (prefix) => {
				const response = await Effect.runPromise(
					serviced
						.mcp(modernMcpRequest(2, "tools/call", { name: "service", arguments: { id: "x" } }))
						.pipe(Effect.provideService(Prefix, prefix)),
				);
				return response.json() as Promise<unknown>;
			}),
		);
		expect(concurrent).toMatchObject([
			{ result: { structuredContent: "alice:x" } },
			{ result: { structuredContent: "bob:x" } },
		]);
	});

	it("uses Effect Schema decoding exactly once for MCP tool input", async () => {
		const transformed = createEffectApi({
			title: "Transformed",
			version: "1",
			basePath: "/",
			operations: [
				operation({
					name: "numbers.double",
					description: "Double an encoded number.",
					method: "POST",
					path: "/double",
					input: Schema.Struct({ count: Schema.NumberFromString }),
					output: Schema.Struct({ doubled: Schema.Number }),
					handler: ({ count }) => Effect.succeed({ doubled: count * 2 }),
				}),
			],
		});

		const listed = await runJson(transformed.mcp(modernMcpRequest(1, "tools/list")));
		expect(listed.body).toMatchObject({
			result: {
				tools: [
					{
						name: "numbers.double",
						inputSchema: { properties: { count: { type: "string" } } },
					},
				],
			},
		});

		const called = await runJson(
			transformed.mcp(
				modernMcpRequest(2, "tools/call", {
					name: "numbers.double",
					arguments: { count: "21" },
				}),
			),
		);
		expect(called.body).toMatchObject({
			result: { resultType: "complete", structuredContent: { doubled: 42 }, isError: false },
		});
	});

	it("derives matching OpenAPI and MCP surfaces", async () => {
		expect(api.openapi.paths["/items/{id}"]?.get).toMatchObject({ operationId: "items.get" });
		const documented = createEffectApi({
			title: "Documented",
			version: "1",
			basePath: "/",
			operations: [
				operation({
					name: "items.update",
					description: "Update an item.",
					method: "POST",
					path: "/items/:id",
					input: Schema.Struct({
						id: Schema.String.check(Schema.isPattern(/^item-[0-9]+$/)),
						count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
					}),
					output: Item,
					handler: ({ id }) => Effect.succeed({ id, ok: true }),
				}),
				operation({
					name: "items.optional",
					description: "Optionally update an item.",
					method: "POST",
					path: "/items/optional",
					input: Schema.Struct({ count: Schema.optional(Schema.Number) }),
					output: Schema.Unknown,
					handler: Effect.succeed,
				}),
			],
		});
		expect(documented.openapi.paths["/items/{id}"]?.post).toMatchObject({
			parameters: [
				{
					name: "id",
					schema: { type: "string", pattern: "^item-[0-9]+$" },
				},
			],
			requestBody: {
				content: {
					"application/json": {
						schema: {
							properties: { count: { type: "integer", minimum: 0 } },
							required: ["count"],
						},
					},
				},
			},
		});
		expect(documented.openapi.paths["/items/optional"]?.post).not.toHaveProperty(
			"requestBody.content.application/json.schema.required",
		);

		const listed = await Effect.runPromise(api.mcp(modernMcpRequest(1, "tools/list")));
		expect(await listed.json()).toMatchObject({
			result: { resultType: "complete", tools: [{ name: "items.get" }] },
		});

		const called = await Effect.runPromise(
			api.mcp(
				modernMcpRequest(2, "tools/call", {
					name: "items.get",
					arguments: { id: "example" },
				}),
			),
		);
		expect(await called.json()).toMatchObject({
			result: {
				resultType: "complete",
				structuredContent: { id: "example", ok: true },
				isError: false,
			},
		});
	});

	it("logs server failures without exposing their Cause", async () => {
		const causes: unknown[] = [];
		const failing = createEffectApi({
			title: "Test API",
			version: "1.0.0",
			basePath: "/api/v1",
			logCause: (_operation, cause) => causes.push(cause),
			operations: [
				operation({
					name: "items.fail",
					description: "Fail safely.",
					method: "GET",
					path: "/failure",
					input: Schema.Struct({}),
					output: Item,
					handler: () => Effect.fail(new Error("database connection details")),
					statusForError: () => 503,
					messageForError: () => "Service temporarily unavailable",
				}),
			],
		});

		const response = await Effect.runPromise(
			failing.fetch(new Request("https://grove.test/api/v1/failure")),
		);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: { code: "operation_failed", message: "Service temporarily unavailable" },
		});

		const mcpFailure = await runJson(
			failing.mcp(modernMcpRequest(7, "tools/call", { name: "items.fail", arguments: {} })),
		);
		expect(mcpFailure.body).toMatchObject({
			result: {
				resultType: "complete",
				isError: true,
				structuredContent: {
					error: { code: "operation_failed", message: "Service temporarily unavailable" },
				},
				content: [
					{
						type: "text",
						text: '{"error":{"code":"operation_failed","message":"Service temporarily unavailable"}}',
					},
				],
			},
		});
		expect(causes).toHaveLength(2);
	});

	it("maps failures, does not log 4xx, and sanitizes unmapped failures and defects", async () => {
		const logged: [string, Cause.Cause<unknown>][] = [];
		const failures = createEffectApi({
			title: "F",
			version: "1",
			basePath: "/",
			logCause: (...args) => logged.push(args),
			operations: [
				operation({
					name: "mapped",
					description: "",
					method: "GET",
					path: "/mapped",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.fail("private-4xx"),
					statusForError: () => 422,
					messageForError: () => "Public message",
				}),
				operation({
					name: "unmapped",
					description: "",
					method: "GET",
					path: "/unmapped",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.fail("private-unmapped"),
				}),
				operation({
					name: "defect",
					description: "",
					method: "GET",
					path: "/defect",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.die("secret defect"),
				}),
			],
		});
		const mapped = await runJson(failures.fetch(new Request("https://x/mapped")));
		expect(mapped).toMatchObject({
			response: { status: 422 },
			body: { error: { message: "Public message" } },
		});
		expect(logged).toHaveLength(0);
		const unmapped = await runJson(failures.fetch(new Request("https://x/unmapped")));
		expect(unmapped).toMatchObject({
			response: { status: 500 },
			body: { error: { message: "The operation failed" } },
		});
		expect(JSON.stringify(unmapped.body)).not.toContain("private");
		const defect = await runJson(failures.fetch(new Request("https://x/defect")));
		expect(defect.response.status).toBe(500);
		expect(JSON.stringify(defect.body)).not.toContain("secret");
		expect(logged.map(([name]) => name)).toEqual(["unmapped", "defect"]);
	});

	it("gives fatal causes precedence and contains invalid or defecting error mappers", async () => {
		const logged: [string, Cause.Cause<unknown>][] = [];
		const mixedMapper = vi.fn(() => 404);
		const unsafe = createEffectApi({
			title: "Unsafe",
			version: "1",
			basePath: "/",
			logCause: (...args) => logged.push(args),
			operations: [
				operation({
					name: "mixed",
					description: "",
					method: "GET",
					path: "/mixed",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () =>
						Effect.failCause(Cause.combine(Cause.fail("expected"), Cause.die("defect"))),
					statusForError: mixedMapper,
				}),
				operation({
					name: "multiple",
					description: "",
					method: "GET",
					path: "/multiple",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.failCause(Cause.combine(Cause.fail("first"), Cause.fail("second"))),
				}),
				operation({
					name: "interrupt",
					description: "",
					method: "GET",
					path: "/interrupt",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.interrupt,
				}),
				...[NaN, 399, 600].map((status, index) =>
					operation({
						name: `invalid-${String(index)}`,
						description: "",
						method: "GET",
						path: `/invalid-${String(index)}`,
						input: Schema.Struct({}),
						output: Schema.Unknown,
						handler: () => Effect.fail("private"),
						statusForError: () => status,
					}),
				),
				operation({
					name: "status-defect",
					description: "",
					method: "GET",
					path: "/status-defect",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.fail("private"),
					statusForError: () => {
						throw new Error("status mapper defect");
					},
				}),
				operation({
					name: "message-defect",
					description: "",
					method: "GET",
					path: "/message-defect",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.fail("private"),
					statusForError: () => 400,
					messageForError: () => {
						throw new Error("message mapper defect");
					},
				}),
			],
		});
		const paths = [
			"mixed",
			"multiple",
			"invalid-0",
			"invalid-1",
			"invalid-2",
			"status-defect",
			"message-defect",
		];
		const interrupted = await Effect.runPromiseExit(
			unsafe.fetch(new Request("https://x/interrupt")),
		);
		expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);

		const results = await Promise.all(
			paths.map((path) => runJson(unsafe.fetch(new Request(`https://x/${path}`)))),
		);
		for (const result of results) {
			expect(result).toMatchObject({
				response: { status: 500 },
				body: { error: { code: "operation_failed", message: "The operation failed" } },
			});
		}
		expect(mixedMapper).not.toHaveBeenCalled();
		expect(logged.map(([name]) => name)).toEqual(paths);
		expect(logged.at(-2)?.[1].reasons).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ _tag: "Die", defect: expect.any(Error) as unknown }),
			]),
		);
	});

	it("uses the default server logger without leaking failures to clients", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const defaultLog = createEffectApi({
			title: "D",
			version: "1",
			basePath: "/",
			operations: [
				operation({
					name: "boom",
					description: "",
					method: "GET",
					path: "/",
					input: Schema.Struct({}),
					output: Schema.Unknown,
					handler: () => Effect.die("internal"),
				}),
			],
		});
		const result = await runJson(defaultLog.fetch(new Request("https://x/")));
		expect(result.body).toEqual({
			error: { code: "operation_failed", message: "The operation failed" },
		});
		expect(error).toHaveBeenCalledWith(expect.stringContaining("boom failed"));
	});

	it("documents every OpenAPI path/body/parameter branch and shared path methods", () => {
		const docs = createEffectApi({
			title: "Docs",
			version: "2",
			basePath: "/v2",
			operations: [
				operation({
					name: "read",
					description: "Read",
					method: "GET",
					path: "/things/:thing_id",
					input: Id,
					output: Item,
					handler: () => Effect.never,
				}),
				operation({
					name: "write",
					description: "Write",
					method: "POST",
					path: "/things/:thing_id",
					body: true,
					input: Id,
					output: Item,
					handler: () => Effect.never,
				}),
				operation({
					name: "plain",
					description: "Plain",
					method: "GET",
					path: "/plain",
					input: Id,
					output: Item,
					handler: () => Effect.never,
				}),
			],
		}).openapi;
		expect(docs).toMatchObject({
			openapi: "3.1.0",
			info: { title: "Docs", version: "2" },
			servers: [{ url: "/v2" }],
		});
		expect(docs.paths["/things/{thing_id}"]?.get).toMatchObject({
			operationId: "read",
			parameters: [{ name: "thing_id", in: "path", required: true }],
			responses: { "200": {}, "400": {} },
		});
		expect(docs.paths["/things/{thing_id}"]?.post).toHaveProperty(
			"requestBody.content.application/json.schema",
		);
		expect(docs.paths["/plain"]?.get).not.toHaveProperty("parameters");
		expect(docs.paths["/plain"]?.get).not.toHaveProperty("requestBody");
	});

	it("logs and sanitizes results that violate the advertised output schema", async () => {
		const logCause = vi.fn();
		const invalidOutput = createEffectApi({
			title: "Invalid output",
			version: "1",
			basePath: "/",
			logCause,
			operations: [
				operation({
					name: "items.invalid",
					description: "Invalid output",
					method: "GET",
					path: "/",
					input: Schema.Struct({}),
					output: Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^item-/)) }),
					handler: () => Effect.succeed({ id: "private-invalid-result" }),
				}),
			],
		});
		const result = await runJson(
			invalidOutput.mcp(
				modernMcpRequest(1, "tools/call", {
					name: "items.invalid",
					arguments: {},
				}),
			),
		);
		expect(result.body).toMatchObject({
			result: {
				isError: true,
				structuredContent: { error: { code: "operation_failed", message: "The operation failed" } },
			},
		});
		expect(JSON.stringify(result.body)).not.toContain("private-invalid-result");
		expect(logCause).toHaveBeenCalledOnce();
	});

	it("interoperates with the official July client without a session", async () => {
		const client = new Client(
			{ name: "interop-test", version: "1" },
			{ versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
		);
		const transport = new StreamableHTTPClientTransport(new URL("https://effect-api.test/mcp"), {
			fetch: async (url, init) => {
				const response = await Effect.runPromise(api.mcp(new Request(url, init)));
				expect(response.headers.has("mcp-session-id")).toBe(false);
				return response;
			},
		});
		try {
			await client.connect(transport);
			expect(await client.listTools()).toMatchObject({ tools: [{ name: "items.get" }] });
			expect(await client.callTool({ name: "items.get", arguments: { id: "sdk" } })).toMatchObject({
				isError: false,
				structuredContent: { id: "sdk", ok: true },
			});
		} finally {
			await client.close();
		}
	});

	it("rejects mismatched routing headers before invoking an operation", async () => {
		const handler = vi.fn(() => Effect.succeed({ id: "never", ok: true }));
		const guarded = createEffectApi({
			title: "Guarded",
			version: "1",
			basePath: "/",
			operations: [
				operation({
					name: "items.get",
					description: "Get an item",
					method: "GET",
					path: "/",
					input: Id,
					output: Item,
					handler,
				}),
			],
		});
		await Promise.all(
			["mcp-method", "mcp-name", "mcp-protocol-version"].map(async (header) => {
				const request = modernMcpRequest(1, "tools/call", {
					name: "items.get",
					arguments: { id: "x" },
				});
				request.headers.set(header, "mismatch");
				const response = await Effect.runPromise(guarded.mcp(request));
				expect(response.status).toBe(400);
			}),
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("serves July discovery and tools with Effect protocol validation", async () => {
		const call = (request: Request) => runJson(api.mcp(request));
		const discovered = await call(modernMcpRequest(1, "server/discover"));
		expect(discovered.response.status).toBe(200);
		expect(discovered.body).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {
				resultType: "complete",
				supportedVersions: [MCP_PROTOCOL_VERSION],
				capabilities: { tools: {} },
				_meta: {
					"io.modelcontextprotocol/serverInfo": { name: "Test API", version: "1.0.0" },
				},
				ttlMs: 0,
				cacheScope: "private",
			},
		});

		const listed = await call(modernMcpRequest(2, "tools/list"));
		expect(listed.body).toMatchObject({
			id: 2,
			result: {
				resultType: "complete",
				tools: [{ name: "items.get", inputSchema: {}, outputSchema: {} }],
				ttlMs: 0,
				cacheScope: "private",
			},
		});

		const missingHeader = modernMcpRequest(3, "tools/list");
		missingHeader.headers.delete("mcp-method");
		const rejectedHeader = await call(missingHeader);
		expect(rejectedHeader).toMatchObject({
			response: { status: 400 },
			body: { error: { code: -32020 } },
		});

		const missingEnvelope = new Request("https://effect-api.test/mcp", {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": MCP_PROTOCOL_VERSION,
				"mcp-method": "tools/list",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
		});
		expect(await call(missingEnvelope)).toMatchObject({
			response: { status: 400 },
			body: { error: { code: -32602 } },
		});

		const invalid = await call(
			modernMcpRequest(5, "tools/call", { name: "items.get", arguments: {} }),
		);
		expect(invalid.body).toMatchObject({
			result: {
				resultType: "complete",
				isError: true,
				structuredContent: { error: { code: "invalid_input" } },
			},
		});

		const success = await call(
			modernMcpRequest(6, "tools/call", {
				name: "items.get",
				arguments: { id: "x" },
			}),
		);
		expect(success.body).toMatchObject({
			result: {
				resultType: "complete",
				isError: false,
				structuredContent: { id: "x", ok: true },
				content: [{ type: "text", text: '{"id":"x","ok":true}' }],
			},
		});

		const legacyResponse = await Effect.runPromise(api.mcp(legacyInitializeRequest()));
		expect(legacyResponse.status).toBe(400);
		expect(await legacyResponse.json()).toHaveProperty("error");
	});
});
