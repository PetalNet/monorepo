import { GROVE_MCP_ISSUER, GROVE_MCP_JWKS_URL, GROVE_MCP_RESOURCE } from "$app/env/private";

import { makeMcpIngress, type McpIngressConfig } from "./mcp/ingress";

const requireRuntimeString = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${name} is required at runtime`);
	return value;
};

const runtimeConfig = (): McpIngressConfig => {
	return {
		issuer: requireRuntimeString(GROVE_MCP_ISSUER, "GROVE_MCP_ISSUER"),
		jwksUrl: requireRuntimeString(GROVE_MCP_JWKS_URL, "GROVE_MCP_JWKS_URL"),
		resourceOrigin: requireRuntimeString(GROVE_MCP_RESOURCE, "GROVE_MCP_RESOURCE"),
	};
};

export const groveMcpIngress = (<T>(initialize: () => T) => {
	let ingress: T | undefined;
	return () => (ingress ??= initialize());
})(() => makeMcpIngress(runtimeConfig()));

export const groveMcpProtectedResourceMetadata = () => groveMcpIngress().metadata();
