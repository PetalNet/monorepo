import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
	makeMcpRequestValidator,
	mcpProtectedResourceMetadata,
	type McpPrincipal,
} from "../src/lib/server/mcp-oauth";

const MCP_REQUIRED_SCOPE = "grove:mcp";
const mcpResource = (origin: string) => `${origin}/mcp`;
const asResponse = (result: McpPrincipal | Response) => {
	expect(result).toBeInstanceOf(Response);
	if (!(result instanceof Response)) throw new TypeError("Expected an OAuth error response");
	return result;
};

const config = {
	issuer: "https://identity.example/application/o/grove-mcp",
	jwksUrl: "https://identity.example/application/o/grove-mcp/jwks",
	resourceOrigin: "https://grove.example",
};

describe("Grove MCP OAuth resource server", () => {
	it("publishes RFC 9728 metadata for the canonical MCP resource", () => {
		expect(mcpProtectedResourceMetadata(config)).toEqual({
			resource: "https://grove.example/mcp",
			authorization_servers: [config.issuer],
			bearer_methods_supported: ["header"],
			scopes_supported: [MCP_REQUIRED_SCOPE],
		});
	});

	it("challenges missing tokens with discoverable protected-resource metadata", async () => {
		const { publicKey } = await generateKeyPair("RS256");
		const validate = makeMcpRequestValidator(
			config,
			createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
		);
		const result = await validate(new Request(mcpResource(config.resourceOrigin)));
		const response = asResponse(result);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			'Bearer resource_metadata="https://grove.example/.well-known/oauth-protected-resource/mcp"',
		);
	});

	it("pins signature, expiry, issuer, audience, subject, and least-privilege scope", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = { ...(await exportJWK(publicKey)), kid: "mcp-test", alg: "RS256", use: "sig" };
		const validate = makeMcpRequestValidator(config, createLocalJWKSet({ keys: [jwk] }));
		const token = (overrides: Record<string, unknown> = {}) => {
			const now = Math.floor(Date.now() / 1000);
			return new SignJWT({
				scope: MCP_REQUIRED_SCOPE,
				iss: config.issuer,
				aud: mcpResource(config.resourceOrigin),
				sub: "mcp-user",
				iat: now,
				exp: now + 300,
				...overrides,
			})
				.setProtectedHeader({ alg: "RS256", kid: "mcp-test" })
				.sign(privateKey);
		};
		const request = async (accessToken: string) =>
			validate(
				new Request(mcpResource(config.resourceOrigin), {
					headers: { authorization: `Bearer ${accessToken}` },
				}),
			);
		const error = async (accessToken: string) =>
			asResponse(await request(accessToken)).headers.get("www-authenticate");

		expect(await request(await token())).toMatchObject({ subject: "mcp-user" });
		expect(await error(await token({ iss: "https://attacker.example" }))).toContain(
			'error="invalid_token"',
		);
		expect(await error(await token({ aud: "https://unrelated.example" }))).toContain(
			'error="invalid_token"',
		);
		expect(await error(await token({ exp: Math.floor(Date.now() / 1000) - 30 }))).toContain(
			'error="invalid_token"',
		);
		expect(await error(await token({ exp: undefined }))).toContain('error="invalid_token"');
		const insufficientScope = asResponse(await request(await token({ scope: "grove:read" })));
		expect(insufficientScope.status).toBe(403);
		expect(insufficientScope.headers.get("www-authenticate")).toContain(
			'error="insufficient_scope"',
		);
	});
});
