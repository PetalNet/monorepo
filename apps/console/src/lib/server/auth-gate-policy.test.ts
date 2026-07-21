import { describe, expect, it } from "vitest";

import { isUnauthenticatedRoute } from "./auth-gate-policy";

describe("hard authentication gate", () => {
	it("exposes the login page", () => {
		expect(isUnauthenticatedRoute("/login")).toBe(true);
	});
	it("exposes the authentication protocol endpoints", () => {
		expect(isUnauthenticatedRoute("/api/auth/callback/oidc")).toBe(true);
	});
	it("hides console and data routes", () => {
		for (const path of ["/", "/api/v1/status", "/anything"])
			expect(isUnauthenticatedRoute(path)).toBe(false);
	});
});
