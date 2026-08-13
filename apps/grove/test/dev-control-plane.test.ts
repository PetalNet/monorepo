import { describe, expect, it } from "vitest";

import {
	devEndpointInventory,
	runDevPreflight,
	safeReturnTo,
} from "../src/lib/server/dev/control-plane";
import { isGroveDevControlPlaneEnabled } from "../src/lib/server/dev/guard";

const preflightConfig = {
	groveOrigin: "https://grove.test",
	browserIssuer: "https://oidc.test/realms/grove",
	mcpIssuer: "https://oidc.test/realms/grove-mcp",
	mcpResourceOrigin: "https://grove.test",
	mcpClientCredentialsAvailable: true,
};

const healthyFetch: typeof fetch = (input) => {
	const url = input instanceof Request ? input.url : input.toString();
	if (url === `${preflightConfig.browserIssuer}/.well-known/openid-configuration`)
		return Promise.resolve(
			Response.json({
				issuer: preflightConfig.browserIssuer,
				authorization_endpoint: `${preflightConfig.browserIssuer}/authorize`,
				token_endpoint: `${preflightConfig.browserIssuer}/token`,
				jwks_uri: `${preflightConfig.browserIssuer}/jwks`,
			}),
		);
	if (url === "https://grove.test/.well-known/oauth-protected-resource/mcp")
		return Promise.resolve(
			Response.json({
				resource: "https://grove.test/mcp",
				authorization_servers: [preflightConfig.mcpIssuer],
				bearer_methods_supported: ["header"],
				scopes_supported: ["grove:mcp", "grove:agent:enroll"],
			}),
		);
	if (url === "https://oidc.test/.well-known/oauth-authorization-server/realms/grove-mcp")
		return Promise.resolve(
			Response.json({
				issuer: preflightConfig.mcpIssuer,
				token_endpoint: `${preflightConfig.mcpIssuer}/token`,
				jwks_uri: `${preflightConfig.mcpIssuer}/jwks`,
				grant_types_supported: ["client_credentials"],
				token_endpoint_auth_methods_supported: ["client_secret_basic"],
			}),
		);
	throw new Error(`Unexpected preflight request: ${url}`);
};

describe("Grove development control plane", () => {
	it("requires development mode and the explicit orb auth flag", () => {
		expect(isGroveDevControlPlaneEnabled(true, "1")).toBe(true);
		expect(isGroveDevControlPlaneEnabled(true, undefined)).toBe(false);
		expect(isGroveDevControlPlaneEnabled(true, "0")).toBe(false);
		expect(isGroveDevControlPlaneEnabled(false, "1")).toBe(false);
	});

	it.each([
		[undefined, "/"],
		["", "/"],
		["sprouts", "/"],
		["//attacker.example/path", "/"],
		["/\\attacker.example/path", "/"],
		["https://attacker.example/path", "/"],
		["/sprouts?filter=mine#today", "/sprouts?filter=mine#today"],
	] as const)("maps returnTo %s to %s", (candidate, expected) => {
		expect(safeReturnTo(candidate)).toBe(expected);
	});

	it("publishes portal-relative routes and characterizes OIDC redirects honestly", () => {
		const inventory = devEndpointInventory("https://grove.test");

		expect(inventory).toMatchObject({
			status: "development-only",
			mcpDevelopmentTrust: {
				browserCookiesAuthorizeMcp: false,
				credentialModel: "shared-owner-orb",
				operatorCanChooseOrImpersonateAgentSubject: true,
				warning: expect.stringContaining("never production-safe") as unknown,
			},
			endpoints: {
				login: {
					method: "GET",
					href: "https://grove.test/__dev/log-me-in/operator?returnTo=/",
					behavior: expect.stringContaining("OIDC redirects") as unknown,
				},
				logout: {
					href: "https://grove.test/__dev/log-me-out?returnTo=/",
				},
				preflight: {
					href: "https://grove.test/__dev/preflight",
				},
			},
		});
		expect(JSON.stringify(inventory)).not.toContain("localhost");
		expect(inventory.mcpDevelopmentTrust.warning).toContain("do not copy it to production");
	});

	it("reports a logged-out fresh orb as ready to log in without binding its owner", async () => {
		const report = await runDevPreflight({
			requestOrigin: "https://grove.test",
			config: preflightConfig,
			homeReadiness: {
				status: "owner-unbound",
				configuredIdentity: {
					issuer: preflightConfig.browserIssuer,
					subject: "operator-development",
				},
			},
			browserSession: null,
			fetch: healthyFetch,
		});

		expect(report).toMatchObject({
			status: "ready",
			readyForLogin: true,
			readyForAgentEnrollment: false,
		});
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "database-runtime", status: "pass", required: true }),
				expect.objectContaining({
					id: "home-host-owner",
					status: "action-required",
					required: false,
				}),
				expect.objectContaining({
					id: "browser-session",
					status: "not-authenticated",
					required: false,
				}),
				expect.objectContaining({ id: "browser-oidc-discovery", status: "pass" }),
				expect.objectContaining({ id: "grove-public-origin", status: "pass" }),
				expect.objectContaining({ id: "oidc-public-origin", status: "pass" }),
				expect.objectContaining({ id: "mcp-protected-resource", status: "pass" }),
				expect.objectContaining({ id: "mcp-authorization-server", status: "pass" }),
				expect.objectContaining({ id: "dev-mcp-credentials", status: "pass" }),
			]),
		);
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "dev-mcp-credentials",
					details: {
						available: true,
						credentialModel: "shared-owner-orb",
						operatorCanChooseOrImpersonateAgentSubject: true,
						productionSafe: false,
					},
				}),
			]),
		);
	});

	it("reports the current browser Actor and enrollment readiness", async () => {
		const report = await runDevPreflight({
			requestOrigin: "https://grove.test",
			config: preflightConfig,
			homeReadiness: { status: "ready", ownerPersonId: "person-owner" },
			browserSession: {
				actor: {
					kind: "person",
					actorId: "person-owner",
					authUserId: "private-auth-user-id",
					name: "Grove Operator",
				},
			},
			fetch: healthyFetch,
		});

		expect(report.readyForAgentEnrollment).toBe(true);
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "browser-session",
					status: "pass",
					details: {
						authenticated: true,
						actor: { kind: "person", actorId: "person-owner", name: "Grove Operator" },
					},
				}),
			]),
		);
		expect(JSON.stringify(report)).not.toContain("private-auth-user-id");
	});

	it("reports a validated browser session without provisioning a missing Actor", async () => {
		const report = await runDevPreflight({
			requestOrigin: "https://grove.test",
			config: preflightConfig,
			homeReadiness: {
				status: "owner-unbound",
				configuredIdentity: {
					issuer: preflightConfig.browserIssuer,
					subject: "operator-development",
				},
			},
			browserSession: { actor: null },
			fetch: healthyFetch,
		});

		expect(report.status).toBe("ready");
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "browser-session",
					required: false,
					status: "action-required",
					details: { authenticated: true, actor: null },
				}),
			]),
		);
	});

	it("keeps MCP enrollment readiness independent from request browser cookies", async () => {
		const report = await runDevPreflight({
			requestOrigin: "https://grove.test",
			config: preflightConfig,
			homeReadiness: { status: "ready", ownerPersonId: "person-owner" },
			browserSession: null,
			fetch: healthyFetch,
		});

		expect(report.readyForAgentEnrollment).toBe(true);
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "browser-session",
					status: "not-authenticated",
					required: false,
				}),
			]),
		);
	});

	it("recognizes TLS termination at the configured public Grove portal", async () => {
		const report = await runDevPreflight({
			requestOrigin: "http://grove.test",
			config: preflightConfig,
			homeReadiness: { status: "ready", ownerPersonId: "person-owner" },
			browserSession: null,
			fetch: healthyFetch,
		});

		expect(report.status).toBe("ready");
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "grove-public-origin", status: "pass" }),
			]),
		);
	});

	it("fails inconsistent dependencies with repairs and never exposes failure or credential values", async () => {
		const report = await runDevPreflight({
			requestOrigin: "https://wrong-grove.test",
			config: { ...preflightConfig, mcpClientCredentialsAvailable: false },
			homeReadiness: undefined,
			browserSession: null,
			fetch: () => Promise.reject(new Error("provider leaked-secret-value")),
		});

		expect(report).toMatchObject({
			status: "not-ready",
			readyForLogin: false,
			readyForAgentEnrollment: false,
		});
		expect(report.checks.filter((check) => check.status === "fail")).not.toHaveLength(0);
		for (const check of report.checks.filter((candidate) => candidate.status === "fail")) {
			expect(check.repair).toEqual(expect.any(String));
			expect(check.repair?.length).toBeGreaterThan(0);
		}
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("leaked-secret-value");
		expect(serialized).not.toContain("clientSecret");
		expect(serialized).not.toContain("cookie");
	});
});
