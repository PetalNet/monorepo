import { createEffectApi, type ApiOperation, type McpRequest } from "@petalnet/effect-api";
import { Effect } from "effect";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

import { enrollAgentSelfOperation } from "../actors/api";
import {
	ActorAuthority,
	ActorDatabaseError,
	ActorDenied,
	type MachineIdentity,
} from "../actors/authority";
import { InvocationContext } from "../invocation";
import { sproutOperations } from "../sprouts/api";

const MCP_SCOPE = "grove:mcp";

export interface McpIngressConfig {
	readonly issuer: string;
	readonly jwksUrl: string;
	readonly resourceOrigin: string;
}

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

const allOperations: readonly ApiOperation<any>[] = [enrollAgentSelfOperation, ...sproutOperations];

export const makeMcpIngress = (input: McpIngressConfig, key?: JWTVerifyGetKey) => {
	const config = validatedConfig(input);
	const verificationKey =
		key ??
		createRemoteJWKSet(new URL(config.jwksUrl), {
			timeoutDuration: 5_000,
			cooldownDuration: 30_000,
		});

	const authenticate = async (request: Request): Promise<MachineIdentity | Response> => {
		const token = tokenFrom(request);
		if (!token) return challenge(config);
		try {
			const { payload } = await jwtVerify(token, verificationKey, {
				issuer: config.issuer,
				audience: resource(config),
				algorithms: ["RS256", "ES256"],
				requiredClaims: ["sub", "exp", "iat"],
			});
			const scopes = scopesFrom(payload);
			if (!scopes.has(MCP_SCOPE)) return challenge(config, "insufficient_scope");
			return { issuer: config.issuer, subject: payload.sub!, scopes };
		} catch (error) {
			return invalidTokenFailure(error)
				? challenge(config, "invalid_token")
				: dependencyUnavailable(error);
		}
	};

	return {
		metadata: () => mcpProtectedResourceMetadata(config),
		handle: (request: Request) =>
			Effect.promise(() => authenticate(request)).pipe(
				Effect.flatMap((identity) => {
					if (identity instanceof Response) return Effect.succeed(identity);
					return Effect.gen(function* () {
						const authority = yield* ActorAuthority;
						const principal = yield* authority.resolveMachineIdentity(identity);
						const body = yield* Effect.promise(() => request.json().catch(() => undefined));
						if (body === undefined || body === null || typeof body !== "object")
							return parseError();
						const mcpRequest = body as McpRequest;
						const authorized = new Set(yield* authority.authorizedOperations(principal));
						const canRetryEnrollment =
							principal.kind === "agent" && identity.scopes.has("grove:agent:enroll");
						if (canRetryEnrollment && mcpRequest.params?.name === "agents.enrollSelf")
							authorized.add("agents.enrollSelf");
						const api = createEffectApi({
							title: "Grove MCP",
							version: "1.0.0",
							basePath: "/mcp",
							operations: allOperations
								.filter((operation) => authorized.has(operation.name))
								.toSorted((left, right) => left.name.localeCompare(right.name)),
						});
						return yield* api.mcp(mcpRequest).pipe(
							Effect.provideService(InvocationContext, {
								principal,
								transport: "mcp",
								requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
							}),
						);
					});
				}),
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
