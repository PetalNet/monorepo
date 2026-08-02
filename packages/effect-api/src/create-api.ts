import { Cause } from "effect";

import { createMcpHandler } from "./mcp.js";
import { createOpenApi } from "./openapi.js";
import type { ApiOperation, LogCause } from "./operation.js";
import { createRestHandler } from "./rest.js";

export interface EffectApiConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly basePath: string;
	readonly operations: readonly ApiOperation<R>[];
	readonly logCause?: LogCause;
}

const defaultLogCause: LogCause = (operationName, cause) => {
	console.error(`${operationName} failed\n${Cause.pretty(cause)}`);
};

/** Build one REST handler, one OpenAPI document, and one MCP server from the operation catalog. */
export function createEffectApi<R>(config: EffectApiConfig<R>) {
	const logCause = config.logCause ?? defaultLogCause;
	return {
		fetch: createRestHandler({
			basePath: config.basePath,
			operations: config.operations,
			logCause,
		}),
		mcp: createMcpHandler({
			title: config.title,
			version: config.version,
			operations: config.operations,
			logCause,
		}),
		openapi: createOpenApi(config),
	} as const;
}
