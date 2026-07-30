import { Cause, Context, Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEffectApi, operation } from "../src/index.js";

const Id = Schema.Struct({ id: Schema.String });
const Item = Schema.Struct({ id: Schema.String, ok: Schema.Boolean });

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

const runJson = async <R>(effect: Effect.Effect<Response, never, R>, service?: R) => {
	const response = await Effect.runPromise(
		service === undefined ? (effect as Effect.Effect<Response>) : Effect.provide(effect, service),
	);
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
		).toBe(200);
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
					schema: { type: "string", allOf: [{ pattern: "^item-[0-9]+$" }] },
				},
			],
			requestBody: {
				content: {
					"application/json": {
						schema: {
							properties: { count: { type: "integer", allOf: [{ minimum: 0 }] } },
							required: ["count"],
						},
					},
				},
			},
		});
		expect(documented.openapi.paths["/items/optional"]?.post).not.toHaveProperty(
			"requestBody.content.application/json.schema.required",
		);

		const listed = await Effect.runPromise(
			api.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		);
		expect(await listed.json()).toMatchObject({
			result: { tools: [{ name: "items.get" }] },
		});

		const called = await Effect.runPromise(
			api.mcp({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "items.get", arguments: { id: "example" } },
			}),
		);
		expect(await called.json()).toMatchObject({
			result: { structuredContent: { id: "example", ok: true }, isError: false },
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
		expect(causes).toHaveLength(1);
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
			"interrupt",
			"invalid-0",
			"invalid-1",
			"invalid-2",
			"status-defect",
			"message-defect",
		];

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

	it("implements MCP validation, discovery, defaults, success, and tool errors", async () => {
		const call = (request: Parameters<typeof api.mcp>[0]) => runJson(api.mcp(request));
		expect((await call({ method: "initialize" })).body).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "Invalid Request" },
		});
		expect((await call({ jsonrpc: "2.0", method: "initialize" })).body).toMatchObject({
			id: null,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "Test API" },
			},
		});
		expect((await call({ jsonrpc: "2.0", id: 0, method: "tools/list" })).body).toMatchObject({
			id: 0,
			result: { tools: [{ name: "items.get", inputSchema: {}, outputSchema: {} }] },
		});
		expect((await call({ jsonrpc: "2.0", method: "wat" })).body).toMatchObject({
			error: { code: -32601 },
		});
		expect((await call({ jsonrpc: "2.0", method: "tools/call" })).body).toMatchObject({
			error: { code: -32602, message: "Unknown tool" },
		});
		const invalid = await call({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "items.get" },
		});
		expect(invalid.body).toMatchObject({
			result: { isError: true, structuredContent: { error: { code: "invalid_input" } } },
		});
		const success = await call({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "items.get", arguments: { id: "x" } },
		});
		expect(success.body).toMatchObject({
			result: {
				isError: false,
				structuredContent: { id: "x", ok: true },
				content: [{ type: "text", text: '{"id":"x","ok":true}' }],
			},
		});
	});
});
