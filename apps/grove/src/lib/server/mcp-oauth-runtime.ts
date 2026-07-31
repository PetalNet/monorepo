import { GROVE_MCP_ISSUER, GROVE_MCP_JWKS_URL, GROVE_MCP_RESOURCE } from "$app/env/private";
import { createRemoteJWKSet } from "jose";

import {
	makeMcpRequestValidator,
	mcpProtectedResourceMetadata,
	type McpOAuthConfig,
	type McpRequestValidator,
} from "./mcp-oauth";

const requireRuntimeString = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${name} is required at runtime`);
	return value;
};

const runtimeConfig = (): McpOAuthConfig => {
	return {
		issuer: requireRuntimeString(GROVE_MCP_ISSUER, "GROVE_MCP_ISSUER"),
		jwksUrl: requireRuntimeString(GROVE_MCP_JWKS_URL, "GROVE_MCP_JWKS_URL"),
		resourceOrigin: requireRuntimeString(GROVE_MCP_RESOURCE, "GROVE_MCP_RESOURCE"),
	};
};

let runtimeValidator: McpRequestValidator | undefined;

export const validateMcpRequest = (request: Request) => {
	if (!runtimeValidator) {
		const config = runtimeConfig();
		runtimeValidator = makeMcpRequestValidator(config, createRemoteJWKSet(new URL(config.jwksUrl)));
	}
	return runtimeValidator(request);
};

export const groveMcpProtectedResourceMetadata = () =>
	mcpProtectedResourceMetadata(runtimeConfig());
