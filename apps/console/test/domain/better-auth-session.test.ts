import { describe, expect, it } from "vitest";

import { authCookiePrefix } from "../../src/lib/server/auth/cookies.ts";
import { resolveBrowserPrincipal } from "../../src/lib/server/domain/auth/browser-principal.ts";
import { devPrincipal } from "../../src/lib/server/domain/auth/principal.ts";
import { parseBetterAuthIdentity } from "../../src/lib/server/domain/auth/session-identity.ts";
import { lanesForTier } from "../../src/lib/server/domain/auth/tier-lanes.ts";
import type { Services } from "../../src/lib/server/domain/substrate.ts";

describe("Better Auth session identity", () => {
	it("accepts only the normalized Authentik identity persisted by the OIDC mapper", () => {
		expect(
			parseBetterAuthIdentity({
				authentikUsername: "parker",
				authentikGroups: JSON.stringify(["owner", "term_admin"]),
				authentikSubject: "ak-user-123",
			}),
		).toEqual({
			kind: "authentik",
			username: "parker",
			groups: ["owner", "term_admin"],
			subject: "ak-user-123",
			sessionId: "",
		});
	});

	it.each([
		["missing username", { authentikGroups: '["owner"]', authentikSubject: "sub" }],
		[
			"unsafe username",
			{ authentikUsername: "../../owner", authentikGroups: '["owner"]', authentikSubject: "sub" },
		],
		["missing subject", { authentikUsername: "parker", authentikGroups: '["owner"]' }],
		[
			"empty groups",
			{ authentikUsername: "parker", authentikGroups: "[]", authentikSubject: "sub" },
		],
		[
			"duplicate groups",
			{
				authentikUsername: "parker",
				authentikGroups: '["owner","owner"]',
				authentikSubject: "sub",
			},
		],
		[
			"malformed groups",
			{ authentikUsername: "parker", authentikGroups: "owner", authentikSubject: "sub" },
		],
	])("fails closed for %s", (_label, user) => {
		expect(parseBetterAuthIdentity(user)).toBeNull();
	});

	it("does not turn a Better Auth-shaped value into the independent dev principal", () => {
		expect(
			devPrincipal(JSON.stringify({ authentikUsername: "parker", authentikGroups: '["owner"]' })),
		).toBeNull();
	});

	it("accepts Authentik group names that contain spaces", () => {
		expect(
			parseBetterAuthIdentity({
				authentikUsername: "janet",
				authentikGroups: JSON.stringify(["authentik Admins", "media"]),
				authentikSubject: "ak-user-janet",
			}),
		).toEqual({
			kind: "authentik",
			username: "janet",
			groups: ["authentik Admins", "media"],
			subject: "ak-user-janet",
			sessionId: "",
		});
	});

	it("accepts the app Better Auth user shape", () => {
		expect(parseBetterAuthIdentity({ id: "user_123", tier: "operator" }, "session_456")).toEqual({
			kind: "app",
			userId: "user_123",
			tier: "operator",
			sessionId: "session_456",
		});
	});

	it("keeps terminal administration outside hierarchical owner lanes", () => {
		expect(lanesForTier("owner")).toEqual(["viewer", "editor", "operator", "admin"]);
		expect(lanesForTier("owner")).not.toContain("term_admin");
	});

	it("uses the same secure cookie prefix as the app auth configuration", () => {
		expect(authCookiePrefix("https://console.example")).toBe("__Host-console");
		expect(authCookiePrefix("http://localhost:5173")).toBe("console");
	});

	it("resolves an app session to the same stable principal used by REST and WebSocket", async () => {
		const sql = Object.assign(async () => [{ object: "user:user_123", head: "z42" }], {
			array: (values: readonly unknown[]) => values,
		});
		const services = { db: { app: sql } } as unknown as Services;
		await expect(
			resolveBrowserPrincipal(services, {
				kind: "app",
				userId: "user_123",
				tier: "owner",
				sessionId: "session_456",
			}),
		).resolves.toEqual({
			kind: "human",
			id: "human:user_123",
			tiers: ["owner"],
			lanes: ["viewer", "editor", "operator", "admin"],
			scopes: ["user:user_123"],
			zookie: "z42",
			authSource: "better-auth",
			authSessionId: "session_456",
		});
	});
});
