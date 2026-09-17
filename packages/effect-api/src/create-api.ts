import { Context, Effect, Layer, Predicate, Schema, Stream, type Scope } from "effect";
import {
	HttpRouter,
	HttpServerError,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";

import { createMcpLayer } from "./mcp.js";
import { createOpenApi } from "./openapi.js";
import { defaultLogCause, type ApiOperation, type LogCause } from "./operation.js";
import { ApiRequest, type McpPermissions } from "./request.js";
import { createRestLayer } from "./rest.js";

export interface EffectApiConfig<R> {
	readonly title: string;
	readonly version: string;
	readonly basePath: string;
	readonly operations: readonly ApiOperation<R>[];
	readonly mcpOperations?: readonly ApiOperation<R>[];
	readonly mcpPath?: `/${string}`;
	readonly logCause?: LogCause;
}

/** The router and protocol fibers live in the application runtime's layer scope. */
export class ApiServer extends Context.Service<
	ApiServer,
	{
		readonly handle: Effect.Effect<
			HttpServerResponse.HttpServerResponse,
			unknown,
			HttpServerRequest.HttpServerRequest | ApiRequest | Scope.Scope
		>;
	}
>()("@petalnet/effect-api/Server") {}

const ParseErrorResponse = Schema.fromJsonString(
	Schema.Struct({
		jsonrpc: Schema.Literal("2.0"),
		id: Schema.Null,
		error: Schema.Struct({ code: Schema.Literal(-32700) }),
	}),
);

/** Declare one application; provide its layer once and execute fetch inside that runtime. */
export function createEffectApi<R>(config: EffectApiConfig<R>) {
	const logCause = config.logCause ?? defaultLogCause;
	const mcpOperations = config.mcpOperations ?? config.operations;
	const all = new Set(mcpOperations.map((operation) => operation.name));
	const routes = Layer.merge(
		createRestLayer({ basePath: config.basePath, operations: config.operations, logCause }),
		createMcpLayer({
			title: config.title,
			version: config.version,
			path: config.mcpPath ?? "/mcp",
			operations: mcpOperations,
			logCause,
		}),
	);
	const layer = Layer.effect(
		ApiServer,
		Effect.map(HttpRouter.toHttpEffect(routes), (handle) => ({ handle })),
	);
	const fetch = Effect.fnUntraced(function* (
		request: Request | HttpServerRequest.HttpServerRequest,
		permissions: McpPermissions = { listed: all, callable: all },
	): Effect.fn.Return<Response, never, R | ApiServer | Scope.Scope> {
		const services = yield* Effect.context<R>();
		const server = yield* ApiServer;
		const incoming = request instanceof Request ? HttpServerRequest.fromWeb(request) : request;
		const handled = server.handle.pipe(
			Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
			Effect.provideService(ApiRequest, { ...permissions, services }),
			Effect.catchIf(
				(error): error is HttpServerError.HttpServerError =>
					error instanceof HttpServerError.HttpServerError &&
					error.reason instanceof HttpServerError.RouteNotFound,
				() =>
					Effect.succeed(
						HttpServerResponse.jsonUnsafe({ error: { code: "not_found" } }, { status: 404 }),
					),
			),
			Effect.orDie,
		);
		const response = yield* request instanceof Request
			? Effect.raceFirst(
					handled,
					Effect.callback<never>((resume) => {
						const abort = () => {
							resume(Effect.interrupt);
						};
						if (request.signal.aborted) abort();
						else request.signal.addEventListener("abort", abort, { once: true });
						return Effect.sync(() => {
							request.signal.removeEventListener("abort", abort);
						});
					}),
				)
			: handled;
		// Normalize the preview's parse-error status at the response boundary.
		if (
			new URL(incoming.originalUrl).pathname === (config.mcpPath ?? "/mcp") &&
			response.status === 200 &&
			Predicate.isTagged(response.body, "Uint8Array") &&
			response.body.contentType === "application/json" &&
			(yield* Stream.make(response.body.body).pipe(
				Stream.decodeText,
				Stream.runFold(
					() => "",
					(text, chunk) => text + chunk,
				),
				Effect.flatMap(Schema.decodeUnknownEffect(ParseErrorResponse)),
				Effect.isSuccess,
			))
		) {
			return HttpServerResponse.toWeb(HttpServerResponse.setStatus(response, 400));
		}
		return HttpServerResponse.toWeb(response);
	}, Effect.scoped);
	return { layer, fetch, mcp: fetch, openapi: createOpenApi(config) } as const;
}
