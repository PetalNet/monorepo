import {
	createMcpHandler as createSdkMcpHandler,
	McpServer,
	type CallToolResult,
	type McpHandlerRequestOptions,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { Effect, Schema } from "effect";

import { invokeOperation, type InvocationResult } from "./invoke.js";
import type { ApiOperation, LogCause } from "./operation.js";

export type McpRequestOptions = McpHandlerRequestOptions;

interface McpConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly operations: readonly ApiOperation<R>[];
	readonly logCause: LogCause;
}

const standardSchema = (schema: Schema.ConstraintDecoder<unknown>): StandardSchemaWithJSON =>
	Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

const contentFor = (result: InvocationResult): CallToolResult => {
	const value =
		result.kind === "success"
			? result.value
			: { error: { code: result.code, message: result.message } };
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
		isError: result.kind === "failure",
	};
};

export const createMcpHandler =
	<R>(config: McpConfig<R>) =>
	(request: Request, options?: McpRequestOptions): Effect.Effect<Response, never, R> =>
		Effect.flatMap(Effect.context<R>(), (context) =>
			Effect.promise(() => {
				const handler = createSdkMcpHandler(() => {
					const server = new McpServer(
						{ name: config.title, version: config.version },
						{ capabilities: { tools: { listChanged: false } } },
					);
					for (const operation of config.operations) {
						server.registerTool(
							operation.name,
							{
								description: operation.description,
								inputSchema: standardSchema(operation.input),
								outputSchema: standardSchema(operation.output),
							},
							(input) =>
								Effect.runPromise(
									invokeOperation(operation, input, config.logCause, {
										inputIsDecoded: true,
									}).pipe(Effect.provide(context)),
								).then(contentFor),
						);
					}
					return server;
				});
				return handler.fetch(request, options);
			}),
		);
