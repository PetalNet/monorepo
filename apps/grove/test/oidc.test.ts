import { describe, expect, it } from "vitest";

import { GROVE_OIDC_PROVIDER_ID, groveOidc } from "../src/lib/server/oidc";

describe("Grove browser OIDC policy", () => {
	it("pins Authorization Code, PKCE, canonical issuer, verified email, and browser-only credentials", () => {
		const plugin = groveOidc({
			issuer: "https://identity.example/realm/grove/",
			clientId: "grove-browser",
			clientSecret: "browser-secret",
			callbackOrigin: "https://grove.example/",
		});
		const provider = plugin.options.config[0];

		expect(provider).toMatchObject({
			providerId: GROVE_OIDC_PROVIDER_ID,
			accountIssuer: "https://identity.example/realm/grove",
			clientId: "grove-browser",
			clientSecret: "browser-secret",
			discoveryUrl: "https://identity.example/realm/grove/.well-known/openid-configuration",
			redirectURI: `https://grove.example/api/auth/callback/${GROVE_OIDC_PROVIDER_ID}`,
			responseType: "code",
			pkce: true,
			requireEmailVerification: true,
			scopes: ["openid", "profile", "email"],
		});
	});
});
