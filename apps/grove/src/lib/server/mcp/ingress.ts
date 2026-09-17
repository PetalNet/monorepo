import { isUtf8 } from "node:buffer";

import type { ApiServer } from "@petalnet/effect-api";
import { Data, Effect, Stream } from "effect";
import { HttpClientRequest, HttpServerRequest, type HttpMethod } from "effect/unstable/http";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

import {
	ActorAuthority,
	ActorDatabaseError,
	ActorDenied,
	type AuthorityError,
	type MachineIdentity,
} from "../actors/authority";
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

class InvalidMcpConfiguration extends Error {
	readonly _tag = "InvalidMcpConfiguration";
}

const canonicalUrl = (value: string, name: string, originOnly = false) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new InvalidMcpConfiguration(`${name} must be an absolute URL`);
	}
	if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
		throw new InvalidMcpConfiguration(`${name} must use HTTPS`);
	if (url.username || url.password || url.search || url.hash)
		throw new InvalidMcpConfiguration(`${name} must not contain credentials, query, or fragment`);
	if (originOnly && url.pathname !== "/")
		throw new InvalidMcpConfiguration(`${name} must be a canonical origin`);
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

const challenge = (config: McpIngressConfig, error?: "invalid_token" | "insufficient_scope") => {
	const values = [`resource_metadata="${metadataUrl(config)}"`];
	if (error) values.push(`error="${error}"`);
	if (error === "insufficient_scope") values.push(`scope="${MCP_SCOPE}"`);
	return new Response(null, {
		status: error === "insufficient_scope" ? 403 : 401,
		headers: { "WWW-Authenticate": `Bearer ${values.join(", ")}` },
	});
};

const tokenFrom = (request: Request) =>
	request.headers.get("authorization")?.match(/^Bearer ([^\s,]+)$/i)?.[1];
const scopesFrom = (payload: JWTPayload) =>
	new Set(typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : []);
const invalidTokenFailure = (error: unknown) =>
	error instanceof errors.JOSEAlgNotAllowed ||
	error instanceof errors.JWSInvalid ||
	error instanceof errors.JWSSignatureVerificationFailed ||
	error instanceof errors.JWTClaimValidationFailed ||
	error instanceof errors.JWTExpired ||
	error instanceof errors.JWTInvalid ||
	error instanceof errors.JWKSNoMatchingKey ||
	error instanceof errors.JWKSMultipleMatchingKeys;

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
	if (mediaType !== "application/json")
		return yield* new McpRejected({ response: unsupportedMediaType() });
	const contentLength = request.headers.get("content-length");
	if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MCP_MAX_REQUEST_BYTES)
		return yield* new McpRejected({ response: requestTooLarge() });
	const body = request.body;
	if (!body) return yield* new McpRejected({ response: parseError() });
	const { chunks, byteLength } = yield* Stream.fromReadableStream({
		evaluate: () => body,
		onError: () => new McpRejected({ response: parseError() }),
	}).pipe(
		Stream.runFoldEffect(
			() => ({ chunks: [] as Uint8Array[], byteLength: 0 }),
			(state, chunk) => {
				state.byteLength += chunk.byteLength;
				if (state.byteLength > MCP_MAX_REQUEST_BYTES)
					return Effect.fail(new McpRejected({ response: requestTooLarge() }));
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
	if (!isUtf8(bytes)) return yield* new McpRejected({ response: parseError() });
	return HttpServerRequest.fromClientRequest(
		HttpClientRequest.make(request.method as HttpMethod.HttpMethod)(request.url).pipe(
			HttpClientRequest.bodyUint8Array(bytes),
			HttpClientRequest.setHeaders(request.headers),
		),
	);
});

export const makeMcpIngress = (input: McpIngressConfig, key?: JWTVerifyGetKey): McpIngress => {
	const config = validatedConfig(input);
	const verificationKey =
		key ??
		createRemoteJWKSet(new URL(config.jwksUrl), {
			timeoutDuration: 5_000,
			cooldownDuration: 30_000,
		});

	const authenticate = Effect.fnUntraced(function* (
		request: Request,
	): Effect.fn.Return<MachineIdentity, McpRejected> {
		const token = tokenFrom(request);
		if (!token) return yield* new McpRejected({ response: challenge(config) });
		const { payload } = yield* Effect.tryPromise({
			try: () =>
				jwtVerify(token, verificationKey, {
					issuer: config.issuer,
					audience: resource(config),
					algorithms: ["RS256", "ES256"],
					requiredClaims: ["sub", "exp", "iat"],
				}),
			catch: (error) =>
				new McpRejected({
					response: invalidTokenFailure(error)
						? challenge(config, "invalid_token")
						: dependencyUnavailable(error),
				}),
		});
		const scopes = scopesFrom(payload);
		if (!scopes.has(MCP_SCOPE))
			return yield* new McpRejected({ response: challenge(config, "insufficient_scope") });
		if (typeof payload.sub !== "string" || payload.sub.length === 0)
			return yield* new McpRejected({ response: challenge(config, "invalid_token") });
		return { issuer: config.issuer, subject: payload.sub, scopes };
	});

	return {
		metadata: () => mcpProtectedResourceMetadata(config),
		handle: Effect.fnUntraced(
			function* (request: Request) {
				const identity = yield* authenticate(request);
				const authority = yield* ActorAuthority;
				const principal = yield* authority.resolveMachineIdentity(identity);
				const incoming = yield* readRequest(request);
				const listed = new Set(yield* authority.authorizedOperations(principal));
				const callable = new Set(listed);
				const canRetryEnrollment =
					principal.kind === "agent" && identity.scopes.has("grove:agent:enroll");
				if (canRetryEnrollment) callable.add("agents.enrollSelf");
				return yield* groveApi.fetch(incoming, { listed, callable }).pipe(
					Effect.provideService(InvocationContext, {
						principal,
						transport: "mcp",
						requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
					}),
				);
			},
			Effect.catchTag("McpRejected", ({ response }) => Effect.succeed(response)),
			Effect.catchIf(
				(error): error is ActorDatabaseError => error instanceof ActorDatabaseError,
				(error) => Effect.succeed(authorityUnavailable(error)),
			),
			Effect.catchIf(
				(error): error is ActorDenied => error instanceof ActorDenied,
				() =>
					Effect.succeed(
						Response.json(
							{ error: "access_denied", message: "MCP identity is not eligible" },
							{ status: 403 },
						),
					),
			),
		),
	};
};
