import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { Cause, Data, Effect, Exit, Fiber, Result, Stream, type Context, type Types } from "effect";
import {
	HttpClientRequest,
	HttpEffect,
	HttpServerError,
	HttpServerRequest,
	HttpServerResponse,
	type HttpMethod,
} from "effect/http";

import type { RequestMiddleware } from "./request.js";

const MCP_MAX_REQUEST_BYTES = 1024 * 1024;

export interface McpIdentity {
	readonly issuer: string;
	readonly subject: string;
	readonly scopes: ReadonlySet<string>;
}

export interface McpAuthenticationConfig<Auth = never> {
	readonly issuer: string;
	readonly jwksUrl: string;
	readonly resourceOrigin: string;
	readonly requiredScopes: readonly string[];
	readonly scopesSupported: readonly string[];
	readonly authenticate: (
		identity: McpIdentity,
	) => Effect.Effect<Context.Context<Auth>, HttpServerResponse.HttpServerResponse, unknown>;
}

export interface McpAuthentication {
	readonly metadata: () => {
		readonly resource: string;
		readonly authorization_servers: readonly string[];
		readonly bearer_methods_supported: readonly string[];
		readonly scopes_supported: readonly string[];
	};
	readonly middleware: RequestMiddleware;
}

class McpRejected extends Data.TaggedError("McpRejected")<{ readonly response: Response }> {}

/** Carries the original Effect cause through Better Auth's Promise callback unchanged. */
class McpInvocationFailed extends Data.TaggedError("McpInvocationFailed")<{
	readonly cause: Cause.Cause<Types.unhandled>;
}> {}

class McpDependencyFailed extends Data.TaggedError("McpDependencyFailed")<{
	readonly cause: unknown;
}> {}

class InvalidMcpConfiguration extends Data.TaggedError("InvalidMcpConfiguration")<{
	readonly message: string;
}> {}

const canonicalUrl = (value: string, name: string, originOnly = false) => {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		throw new InvalidMcpConfiguration({ message: `${name} must be an absolute URL` });
	}

	if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
		throw new InvalidMcpConfiguration({ message: `${name} must use HTTPS` });
	}

	if (url.username || url.password || url.search || url.hash) {
		throw new InvalidMcpConfiguration({
			message: `${name} must not contain credentials, query, or fragment`,
		});
	}

	if (originOnly && url.pathname !== "/") {
		throw new InvalidMcpConfiguration({ message: `${name} must be a canonical origin` });
	}

	return url.href.replace(/\/$/, "");
};

const validatedConfig = <Auth>(
	config: McpAuthenticationConfig<Auth>,
): McpAuthenticationConfig<Auth> => ({
	...config,
	issuer: canonicalUrl(config.issuer, "issuer"),
	jwksUrl: canonicalUrl(config.jwksUrl, "jwksUrl"),
	resourceOrigin: canonicalUrl(config.resourceOrigin, "resourceOrigin", true),
});

const resource = (config: McpAuthenticationConfig) => `${config.resourceOrigin}/mcp`;
const metadataUrl = (config: McpAuthenticationConfig) =>
	`${config.resourceOrigin}/.well-known/oauth-protected-resource/mcp`;

const dependencyUnavailable = (error: unknown) => {
	console.error("MCP JWKS dependency unavailable", error);

	return Response.json(
		{ error: "identity_provider_unavailable", message: "MCP identity validation is unavailable" },
		{ status: 503 },
	);
};

const parseError = () =>
	Response.json(
		{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
		{ status: 400 },
	);

const unsupportedMediaType = () =>
	Response.json(
		{ error: "unsupported_media_type", message: "MCP requests must use application/json" },
		{ status: 415 },
	);

const requestTooLarge = () =>
	Response.json(
		{ error: "request_too_large", message: "MCP requests must not exceed 1 MiB" },
		{ status: 413 },
	);

const readRequest = Effect.fnUntraced(function* (request: Request) {
	const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

	if (mediaType !== "application/json") {
		return yield* new McpRejected({ response: unsupportedMediaType() });
	}

	const contentLength = request.headers.get("content-length");

	if (
		contentLength &&
		/^\d+$/.test(contentLength) &&
		Number(contentLength) > MCP_MAX_REQUEST_BYTES
	) {
		return yield* new McpRejected({ response: requestTooLarge() });
	}

	const body = request.body;

	if (!body) {
		return yield* new McpRejected({ response: parseError() });
	}

	const { chunks, byteLength } = yield* Stream.fromReadableStream({
		evaluate: () => body,
		onError: () => new McpRejected({ response: parseError() }),
	}).pipe(
		Stream.runFoldEffect(
			() => ({ chunks: [] as Uint8Array[], byteLength: 0 }),
			(state, chunk) => {
				state.byteLength += chunk.byteLength;

				if (state.byteLength > MCP_MAX_REQUEST_BYTES) {
					return Effect.fail(new McpRejected({ response: requestTooLarge() }));
				}

				state.chunks.push(chunk);

				return Effect.succeed(state);
			},
		),
	);

	const bytes = new Uint8Array(byteLength);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	// Validate UTF-8 without parsing JSON; MCP owns protocol decoding and routing.
	yield* Effect.try({
		try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		catch: () => new McpRejected({ response: parseError() }),
	});

	return HttpServerRequest.fromClientRequest(
		HttpClientRequest.make(request.method as HttpMethod.HttpMethod)(request.url).pipe(
			HttpClientRequest.bodyUint8Array(bytes),
			HttpClientRequest.setHeaders(request.headers),
		),
	);
});

export const createMcpAuthentication = <Auth>(
	input: McpAuthenticationConfig<Auth>,
): McpAuthentication => {
	const config = validatedConfig(input);

	const dispatch = Effect.fnUntraced(
		function* (
			request: Request,
			identity: McpIdentity,
			next: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled, unknown>,
		) {
			const authentication = yield* Effect.result(config.authenticate(identity));

			if (Result.isFailure(authentication)) {
				return HttpServerResponse.toWeb(authentication.failure);
			}

			return yield* Effect.gen(function* () {
				const incoming = yield* readRequest(request);

				return yield* next.pipe(
					Effect.flatMap((response) =>
						Effect.contextWith((context) =>
							Effect.succeed(
								HttpServerResponse.toWeb(HttpEffect.scopeTransferToStream(response), { context }),
							),
						),
					),
					Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
				);
			}).pipe(Effect.provide(authentication.success));
		},
		Effect.catchTag("McpRejected", ({ response }) => Effect.succeed(response)),
	);

	return {
		metadata: () => ({
			resource: resource(config),
			authorization_servers: [config.issuer],
			bearer_methods_supported: ["header"],
			scopes_supported: config.scopesSupported,
		}),
		middleware: Effect.fnUntraced(function* (
			next: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled, unknown>,
		) {
			const nativeRequest = yield* HttpServerRequest.HttpServerRequest;
			const converted = yield* Effect.result(HttpServerRequest.toWeb(nativeRequest));

			if (Result.isFailure(converted)) {
				const [response] = yield* HttpServerError.causeResponse(Cause.fail(converted.failure));

				return response;
			}

			const request = converted.success;
			const services = yield* Effect.context<unknown>();
			const scope = yield* Effect.scope;

			return yield* Effect.tryPromise({
				try: (signal) =>
					createMcpProtectedRequestHandler(
						{
							issuer: config.issuer,
							audience: resource(config),
							jwksUrl: config.jwksUrl,
							jwtVerifyOptions: {
								algorithms: ["RS256", "ES256"],
								requiredClaims: ["sub", "exp", "iat"],
							},
							requiredScopes: config.requiredScopes,
						},
						(incoming, claims) => {
							// Better Auth cannot cancel JWKS fetching; do not start work after it was abandoned.
							if (signal.aborted || incoming.signal.aborted) {
								return Promise.reject(new McpInvocationFailed({ cause: Cause.interrupt() }));
							}

							if (typeof claims.sub !== "string" || claims.sub.length === 0) {
								return Promise.resolve(
									new Response(null, {
										status: 401,
										headers: {
											"WWW-Authenticate": `Bearer resource_metadata="${metadataUrl(config)}"`,
										},
									}),
								);
							}

							// Reuse this request's services and interruption; do not create another ManagedRuntime.
							return Effect.runPromiseExitWith(services)(
								dispatch(
									incoming,
									{
										issuer: config.issuer,
										subject: claims.sub,
										// Admission scopes are validated by Better Auth; a scope-less token has no grants.
										scopes: new Set(
											typeof claims["scope"] === "string" ? claims["scope"].split(" ") : [],
										),
									},
									next,
								).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
								{ signal: AbortSignal.any([signal, incoming.signal]) },
							).then((exit) => {
								if (Exit.isFailure(exit)) {
									throw new McpInvocationFailed({ cause: exit.cause });
								}

								return exit.value;
							});
						},
					)(request),
				catch: (error) =>
					error instanceof McpInvocationFailed ? error : new McpDependencyFailed({ cause: error }),
			}).pipe(
				Effect.catchTags({
					McpInvocationFailed: (error) => Effect.failCause(error.cause),
					McpDependencyFailed: (error) => Effect.succeed(dependencyUnavailable(error.cause)),
				}),
				Effect.map(HttpServerResponse.fromWeb),
			);
		}),
	};
};
