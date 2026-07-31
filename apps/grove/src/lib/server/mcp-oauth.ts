import { jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

export const MCP_REQUIRED_SCOPE = "grove:mcp";

export interface McpOAuthConfig {
	readonly issuer: string;
	readonly jwksUrl: string;
	readonly resourceOrigin: string;
}

export interface McpPrincipal {
	readonly subject: string;
	readonly scopes: ReadonlySet<string>;
}

export const mcpResource = (origin: string) => `${origin.replace(/\/+$/, "")}/mcp`;

export const mcpResourceMetadataUrl = (origin: string) =>
	`${origin.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/mcp`;

export const mcpProtectedResourceMetadata = (config: McpOAuthConfig) => ({
	resource: mcpResource(config.resourceOrigin),
	authorization_servers: [config.issuer],
	bearer_methods_supported: ["header"],
	scopes_supported: [MCP_REQUIRED_SCOPE],
});

const challenge = (config: McpOAuthConfig, error?: "invalid_token" | "insufficient_scope") => {
	const values = [`resource_metadata="${mcpResourceMetadataUrl(config.resourceOrigin)}"`];
	if (error) values.push(`error="${error}"`);
	if (error === "insufficient_scope") values.push(`scope="${MCP_REQUIRED_SCOPE}"`);
	return new Response(null, {
		status: error === "insufficient_scope" ? 403 : 401,
		headers: { "WWW-Authenticate": `Bearer ${values.join(", ")}` },
	});
};

const bearerToken = (request: Request) => {
	const authorization = request.headers.get("authorization");
	const match = authorization?.match(/^Bearer ([^\s,]+)$/i);
	return match?.[1];
};

const scopesFrom = (payload: JWTPayload) =>
	new Set(typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : []);

export const makeMcpRequestValidator =
	(config: McpOAuthConfig, key: JWTVerifyGetKey) =>
	async (request: Request): Promise<McpPrincipal | Response> => {
		const token = bearerToken(request);
		if (!token) return challenge(config);

		try {
			const { payload } = await jwtVerify(token, key, {
				issuer: config.issuer,
				audience: mcpResource(config.resourceOrigin),
				algorithms: ["RS256", "ES256"],
				requiredClaims: ["exp"],
			});
			if (!payload.sub) return challenge(config, "invalid_token");
			const scopes = scopesFrom(payload);
			if (!scopes.has(MCP_REQUIRED_SCOPE)) return challenge(config, "insufficient_scope");
			return { subject: payload.sub, scopes };
		} catch {
			return challenge(config, "invalid_token");
		}
	};
