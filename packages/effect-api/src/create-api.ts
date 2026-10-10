import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiScalar } from "effect/http-api";

import { createMcpLayer } from "./mcp.js";
import { defaultLogCause, type ApiOperation, type LogCause } from "./operation.js";
import { ApiRequest, inHostRequest, McpAccess, type RequestMiddleware } from "./request.js";
import { createRestApi } from "./rest.js";

export interface EffectApiConfig<R = unknown> {
	readonly title: string;
	readonly version: string;
	readonly basePath: `/${string}`;
	readonly operations: readonly ApiOperation<R>[];
	readonly mcpOperations?: readonly ApiOperation<R>[];
	readonly mcpPath?: `/${string}`;
	/** Scalar reference path. Defaults to <basePath>/docs. */
	readonly docsPath?: `/${string}`;
	readonly scalar?: HttpApiScalar.ScalarConfig;
	readonly restMiddleware?: RequestMiddleware;
	readonly mcpMiddleware?: RequestMiddleware;
	readonly logCause?: LogCause;
}

/** Compose native HTTP services; the host framework owns request execution. */
export function createEffectApi(config: EffectApiConfig) {
	const logCause = config.logCause ?? defaultLogCause;
	const prefix = `${config.basePath}${config.basePath.endsWith("/") ? "" : "/"}` as const;
	const openapiPath = `${prefix}openapi.json` as const;
	const docsPath = config.docsPath ?? (`${prefix}docs` as const);
	const rest = createRestApi({ ...config, openapiPath, logCause });
	const mcpOperations = config.mcpOperations ?? config.operations;
	const all = new Set(mcpOperations.map((operation) => operation.name));
	const mcp = createMcpLayer({
		title: config.title,
		version: config.version,
		path: config.mcpPath ?? "/mcp",
		operations: mcpOperations,
		logCause,
	}).pipe(
		Layer.provide(
			HttpRouter.middleware<{ provides: ApiRequest }>()((httpEffect) => {
				const captured = Effect.gen(function* () {
					const services = yield* Effect.context();
					const access = yield* Effect.serviceOption(McpAccess);
					const permissions = Option.getOrElse(access, () => ({ listed: all, callable: all }));

					return yield* Effect.provideService(httpEffect, ApiRequest, { ...permissions, services });
				});

				return inHostRequest(config.mcpMiddleware ? config.mcpMiddleware(captured) : captured);
			}).layer,
		),
	);
	const routes = Layer.mergeAll(
		rest.layer,
		mcp,
		HttpApiScalar.layer(rest.api, {
			path: docsPath,
			...(config.scalar ? { scalar: config.scalar } : {}),
		}),
	);
	const layer = routes.pipe(Layer.provideMerge(HttpRouter.layer));

	return { layer };
}
