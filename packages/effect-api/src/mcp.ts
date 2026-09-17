import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpServerRequest } from "effect/unstable/http";

import { invokeOperation } from "./invoke.js";
import type { ApiOperation, LogCause } from "./operation.js";
import { ApiRequest } from "./request.js";

interface McpConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly path: `/${string}`;
	readonly operations: readonly ApiOperation<R>[];
	readonly logCause: LogCause;
}

// The public protocol adapter erases its core argument. Describe only the public
// tool operations we decorate; preserve every other operation unchanged.
interface ToolCore {
	readonly tools: {
		readonly list: (profile: unknown) => Effect.Effect<readonly McpSchema.Tool[]>;
		readonly call: (
			call: { readonly name: string },
			invocation: unknown,
		) => Effect.Effect<unknown, unknown>;
	};
}

const protocol: McpProtocol.ProtocolAdapter = {
	...McpProtocol.v2026_07_28,
	installHandlers: (core: ToolCore, lifecycle: unknown, target: unknown) =>
		McpProtocol.v2026_07_28.installHandlers(
			{
				...core,
				tools: {
					...core.tools,
					list: Effect.fnUntraced(function* (profile: unknown) {
						const access = yield* ApiRequest;
						const request = yield* HttpServerRequest.HttpServerRequest;
						const allowed =
							request.headers["mcp-method"] === "tools/call" ? access.callable : access.listed;
						return (yield* core.tools.list(profile)).filter((tool) => allowed.has(tool.name));
					}),
					call: Effect.fnUntraced(function* (call: { readonly name: string }, invocation: unknown) {
						const access = yield* ApiRequest;
						if (!access.callable.has(call.name)) {
							return yield* new McpSchema.InvalidParams({ message: "Unknown tool" });
						}
						return yield* core.tools.call(call, invocation);
					}),
				},
			},
			lifecycle,
			target,
		),
};

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const contentFor = Effect.fnUntraced(function* (value: Schema.Json, isError: boolean) {
	const text = yield* encodeJson(value);
	return new McpSchema.CallToolResult({
		content: [{ type: "text", text }],
		structuredContent: value,
		isError,
	});
});

/** Register once; identity, permissions and domain services come from the invoking request. */
export const createMcpLayer = <R>(config: McpConfig<R>) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const server = yield* McpServer.McpServer;
			for (const operation of config.operations) {
				yield* server.addTool({
					tool: new McpSchema.Tool({
						name: operation.name,
						description: operation.description,
						inputSchema: yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)({
							type: "object",
							...Tool.getJsonSchemaFromSchema(operation.input),
						}),
						outputSchema: yield* Schema.decodeUnknownEffect(McpSchema.ToolOutputJson)(
							Tool.getJsonSchemaFromSchema(operation.output),
						),
					}),
					annotations: Context.empty(),
					handle: Effect.fnUntraced(function* (input: unknown) {
						// MCP erases custom handler requirements; fail closed if invoked outside our HTTP boundary.
						const current = yield* Effect.serviceOption(ApiRequest);
						if (Option.isNone(current)) return yield* Effect.die("Missing API request context");
						const request = current.value;
						return yield* invokeOperation(operation, input, config.logCause).pipe(
							Effect.provide(request.services),
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
							Effect.flatMap((value) => contentFor(value, false)),
							Effect.catchTags({
								InvocationFailure: (failure) =>
									contentFor(
										{
											error: { code: failure.code, message: failure.message },
										},
										true,
									).pipe(Effect.orDie),
								SchemaError: (error) => {
									config.logCause(operation.name, Cause.fail(error));
									return contentFor(
										{ error: { code: "operation_failed", message: "The operation failed" } },
										true,
									).pipe(Effect.orDie);
								},
							}),
						);
					}),
				});
			}
		}),
	).pipe(
		Layer.provide(
			McpServer.layerHttp({
				name: config.title,
				version: config.version,
				path: config.path,
				protocols: [protocol],
			}),
		),
	);
