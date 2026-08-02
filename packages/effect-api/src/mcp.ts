import { Effect, Schema } from "effect";

import { invokeOperation, type InvocationResult } from "./invoke.js";
import type { ApiOperation, LogCause } from "./operation.js";

export interface McpRequest {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: { readonly name?: unknown; readonly arguments?: unknown };
}

interface McpConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly operations: readonly ApiOperation<R>[];
	readonly logCause: LogCause;
}

const json = (value: unknown): Response => Response.json(value);
const schemaJson = (schema: Schema.Constraint): object =>
	Schema.toJsonSchemaDocument(schema).schema;

const contentFor = (result: InvocationResult) => {
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
	(request: McpRequest): Effect.Effect<Response, never, R> => {
		const id = request.id ?? null;
		const result = (value: unknown) => json({ jsonrpc: "2.0", id, result: value });
		const failure = (code: number, message: string) =>
			json({ jsonrpc: "2.0", id, error: { code, message } });
		if (request.jsonrpc !== "2.0") return Effect.succeed(failure(-32600, "Invalid Request"));
		if (request.method === "initialize")
			return Effect.succeed(
				result({
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: config.title, version: config.version },
				}),
			);
		if (request.method === "tools/list")
			return Effect.succeed(
				result({
					tools: config.operations.map((operation) => ({
						name: operation.name,
						description: operation.description,
						inputSchema: schemaJson(operation.input),
						outputSchema: schemaJson(operation.output),
					})),
				}),
			);
		if (request.method !== "tools/call") return Effect.succeed(failure(-32601, "Method not found"));
		const selected = config.operations.find((operation) => operation.name === request.params?.name);
		if (!selected) return Effect.succeed(failure(-32602, "Unknown tool"));
		return Effect.suspend(() =>
			invokeOperation(selected, request.params?.arguments ?? {}, config.logCause).pipe(
				Effect.map((invocation) => result(contentFor(invocation))),
			),
		);
	};
