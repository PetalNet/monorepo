import { Context, Effect, Layer, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { invokeOperation, type InvocationResult } from "./invoke.js";
import type { ApiOperation, LogCause } from "./operation.js";

export interface McpRequestOptions {
	/** A body already parsed and bounded by the authenticated ingress. */
	readonly parsedBody?: unknown;
}

interface McpConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly operations: readonly ApiOperation<R>[];
	readonly logCause: LogCause;
}

const contentFor = (result: InvocationResult): McpSchema.CallToolResult => {
	const value =
		result.kind === "success"
			? result.value
			: { error: { code: result.code, message: result.message } };
	return new McpSchema.CallToolResult({
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: Schema.decodeUnknownSync(Schema.Json)(value),
		isError: result.kind === "failure",
	});
};

export const createMcpHandler = <R>(config: McpConfig<R>) =>
	Effect.fnUntraced(
		function* (request: Request, options?: McpRequestOptions) {
			const context = yield* Effect.context<R>();
			// Keep both the authorized catalog and captured services local to this request.
			const tools = Layer.effectDiscard(
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
							handle: (input: unknown) =>
								Effect.gen(function* () {
									const result = yield* invokeOperation(operation, input, config.logCause);
									if (result.kind === "success") {
										yield* Schema.decodeUnknownEffect(operation.output)(result.value);
									}
									return contentFor(result);
								}).pipe(
									Effect.catchCause((cause) => {
										config.logCause(operation.name, cause);
										return Effect.succeed(
											contentFor({
												kind: "failure",
												status: 500,
												code: "operation_failed",
												message: "The operation failed",
											}),
										);
									}),
									Effect.provide(context),
								),
						});
					}
				}),
			).pipe(
				Layer.provide(
					McpServer.layerHttp({
						name: config.title,
						version: config.version,
						path: new URL(request.url).pathname as `/${string}`,
						protocols: [McpProtocol.v2026_07_28],
					}),
				),
			);
			const handler = yield* HttpRouter.toHttpEffect(tools);
			const incoming =
				options?.parsedBody === undefined
					? request
					: new Request(request.url, {
							method: request.method,
							headers: request.headers,
							body: JSON.stringify(options.parsedBody),
							signal: request.signal,
						});
			const response = yield* handler.pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(incoming),
				),
			);
			return HttpServerResponse.toWeb(response);
		},
		Effect.scoped,
		Effect.orDie,
	);
