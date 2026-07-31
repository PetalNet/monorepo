import { GROVE_MCP_ISSUER, GROVE_MCP_JWKS_URL, GROVE_MCP_RESOURCE } from "$app/env/private";
import { createRemoteJWKSet } from "jose";

import {
	makeMcpRequestValidator,
	mcpProtectedResourceMetadata,
	type McpOAuthConfig,
} from "./mcp-oauth";

const runtimeConfig = (): McpOAuthConfig => {
	if (!GROVE_MCP_ISSUER || !GROVE_MCP_JWKS_URL || !GROVE_MCP_RESOURCE)
		throw new Error("Grove MCP OAuth configuration is required at runtime");
	return {
		issuer: GROVE_MCP_ISSUER,
		jwksUrl: GROVE_MCP_JWKS_URL,
		resourceOrigin: GROVE_MCP_RESOURCE,
	};
};

let runtimeValidator: ReturnType<typeof makeMcpRequestValidator> | undefined;

export const validateMcpRequest = (request: Request) => {
	if (!runtimeValidator) {
		const config = runtimeConfig();
		runtimeValidator = makeMcpRequestValidator(config, createRemoteJWKSet(new URL(config.jwksUrl)));
	}
	return runtimeValidator(request);
};

export const groveMcpProtectedResourceMetadata = () =>
	mcpProtectedResourceMetadata(runtimeConfig());
