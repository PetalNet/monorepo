import { isUtf8 } from "node:buffer";

import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import type { ApiServer } from "@petalnet/effect-api";
import { Cause, Data, Effect, Exit, Fiber, Stream } from "effect";
import { HttpClientRequest, HttpServerRequest, type HttpMethod } from "effect/http";
import type { JWTPayload } from "jose";

import type { ActorDatabaseError } from "../actors/authority";
import { ActorAuthority, type AuthorityError, type MachineIdentity } from "../actors/authority";
import { groveApi } from "../api";
import { InvocationContext } from "../invocation";
import type { SproutCommands } from "../sprouts/service";

const MCP_SCOPE = "grove:mcp";
const MCP_MAX_REQUEST_BYTES = 1024 * 1024;

export interface McpIngressConfig {
	readonly issuer: string;
	readonly jwksUrl: string;
	readonly resourceOrigin: string;
}

export interface McpIngress {
	readonly metadata: () => {
		readonly resource: string;
		readonly authorization_servers: readonly string[];
		readonly bearer_methods_supported: readonly string[];
		readonly scopes_supported: readonly string[];
	};
	readonly handle: (
		request: Request,
	) => Effect.Effect<Response, AuthorityError, ActorAuthority | SproutCommands | ApiServer>;
}

class McpRejected extends Data.TaggedError("McpRejected")<{ readonly response: Response }> {}

/** Carries the original Effect cause through Better Auth's Promise callback unchanged. */
class McpInvocationFailed extends Data.TaggedError("McpInvocationFailed")<{
	readonly cause: Cause.Cause<AuthorityError>;
}> {}

class McpDependencyFailed extends Data.TaggedError("McpDependencyFailed")<{
	readonly cause: unknown;
}> {}

class InvalidMcpConfiguration extends Data.TaggedError("InvalidMcpConfiguration")<{
	readonly message: string;
}> {
	constructor(message: string) {
		super({ message });
	}
}

const canonicalUrl = (value: string, name: string, originOnly = false) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new InvalidMcpConfiguration(`${name} must be an absolute URL`);
	}
	if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
		throw new InvalidMcpConfiguration(`${name} must use HTTPS`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new InvalidMcpConfiguration(`${name} must not contain credentials, query, or fragment`);
	}
	if (originOnly && url.pathname !== "/") {
		throw new InvalidMcpConfiguration(`${name} must be a canonical origin`);
	}
	return url.href.replace(/\/$/, "");
};

const validatedConfig = (config: McpIngressConfig): McpIngressConfig => ({
	issuer: canonicalUrl(config.issuer, "GROVE_MCP_ISSUER"),
	jwksUrl: canonicalUrl(config.jwksUrl, "GROVE_MCP_JWKS_URL"),
	resourceOrigin: canonicalUrl(config.resourceOrigin, "GROVE_MCP_RESOURCE", true),
});

const resource = (config: McpIngressConfig) => `${config.resourceOrigin}/mcp`;
const metadataUrl = (config: McpIngressConfig) =>
	`${config.resourceOrigin}/.well-known/oauth-protected-resource/mcp`;

const mcpProtectedResourceMetadata = (config: McpIngressConfig) => {
	const checked = validatedConfig(config);
	return {
		resource: resource(checked),
		authorization_servers: [checked.issuer],
		bearer_methods_supported: ["header"],
		scopes_supported: [MCP_SCOPE, "grove:agent:enroll"],
	};
};

const dependencyUnavailable = (error: unknown) => {
	console.error("Grove MCP JWKS dependency unavailable", error);
	return Response.json(
		{ error: "identity_provider_unavailable", message: "MCP identity validation is unavailable" },
		{ status: 503 },
	);
};

const authorityUnavailable = (error: ActorDatabaseError) => {
	console.error("Grove MCP actor authority unavailable", error.cause);
	return Response.json(
		{ error: "authority_unavailable", message: "MCP actor resolution is unavailable" },
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
	if (!isUtf8(bytes)) {
		return yield* new McpRejected({ response: parseError() });
	}
	return HttpServerRequest.fromClientRequest(
		HttpClientRequest.make(request.method as HttpMethod.HttpMethod)(request.url).pipe(
			HttpClientRequest.bodyUint8Array(bytes),
			HttpClientRequest.setHeaders(request.headers),
		),
	);
});

export const makeMcpIngress = (input: McpIngressConfig): McpIngress => {
	const config = validatedConfig(input);

	const dispatch = Effect.fnUntraced(
		function* (request: Request, identity: MachineIdentity) {
			const authority = yield* ActorAuthority;
			const principal = yield* authority.resolveMachineIdentity(identity);
			const incoming = yield* readRequest(request);
			const listed = new Set(yield* authority.authorizedOperations(principal));
			const callable = new Set(listed);
			const canRetryEnrollment =
				principal.kind === "agent" && identity.scopes.has("grove:agent:enroll");
			if (canRetryEnrollment) {
				callable.add("agents.enrollSelf");
			}
			return yield* groveApi.fetch(incoming, { listed, callable }).pipe(
				Effect.provideService(InvocationContext, {
					principal,
				}),
			);
		},
		Effect.catchTags({
			McpRejected: ({ response }) => Effect.succeed(response),
			ActorDatabaseError: (error) => Effect.succeed(authorityUnavailable(error)),
			ActorDenied: () =>
				Effect.succeed(
					Response.json(
						{ error: "access_denied", message: "MCP identity is not eligible" },
						{ status: 403 },
					),
				),
		}),
	);

	return {
		metadata: () => mcpProtectedResourceMetadata(config),
		handle: Effect.fnUntraced(function* (request: Request) {
			const services = yield* Effect.context<ActorAuthority | SproutCommands | ApiServer>();
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
							requiredScopes: [MCP_SCOPE],
						},
						async (incoming: Request, claims: JWTPayload) => {
							// Better Auth cannot cancel JWKS fetching; do not start work after it was abandoned.
							if (signal.aborted || incoming.signal.aborted) {
								throw new McpInvocationFailed({ cause: Cause.interrupt() });
							}
							if (typeof claims.sub !== "string" || claims.sub.length === 0) {
								return new Response(null, {
									status: 401,
									headers: {
										"WWW-Authenticate": `Bearer resource_metadata="${metadataUrl(config)}"`,
									},
								});
							}
							// Reuse this request's services and interruption; do not create another ManagedRuntime.
							const exit = await Effect.runPromiseExitWith(services)(
								dispatch(incoming, {
									issuer: config.issuer,
									subject: claims.sub,
									// Better Auth has already validated the scope grammar and admission scope.
									scopes: new Set((claims.scope as string).split(" ")),
								}).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
								{ signal: AbortSignal.any([signal, incoming.signal]) },
							);
							if (Exit.isFailure(exit)) {
								throw new McpInvocationFailed({ cause: exit.cause });
							}
							return exit.value;
						},
					)(request),
				catch: (error) =>
					error instanceof McpInvocationFailed ? error : new McpDependencyFailed({ cause: error }),
			}).pipe(
				Effect.catchTags({
					McpInvocationFailed: (error) => Effect.failCause(error.cause),
					McpDependencyFailed: (error) => Effect.succeed(dependencyUnavailable(error.cause)),
				}),
			);
		}, Effect.scoped),
	};
};
