import { vi } from "vitest";

// Integration tests supply their own domain layers, not process-level credentials.
vi.mock("$app/env/private", () => ({
	BETTER_AUTH_SECRET: "test-only-auth-secret-not-for-production",
	BETTER_AUTH_URL: "https://grove.test",
	DATABASE_URL: "postgresql://grove:grove@localhost/grove_test",
	GROVE_OIDC_CLIENT_ID: "grove-test",
	GROVE_OIDC_CLIENT_SECRET: "test-only-client-secret",
	GROVE_OIDC_ISSUER: "https://identity.test",
	GROVE_HOME_OWNER_ISSUER: "https://identity.test",
	GROVE_HOME_OWNER_SUBJECT: "owner",
	GROVE_MCP_ISSUER: "https://machine.test",
	GROVE_MCP_JWKS_URL: "https://machine.test/jwks",
	GROVE_MCP_RESOURCE: "https://grove.test",
}));
