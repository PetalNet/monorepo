import { memoryAdapter } from "better-auth/adapters/memory";
import { betterAuth } from "better-auth/minimal";
import { describe, expect, it } from "vitest";

import { GROVE_OIDC_PROVIDER_ID, groveOidc } from "../src/lib/server/oidc";

const base64Url = (value: string | ArrayBuffer) =>
	Buffer.from(typeof value === "string" ? value : new Uint8Array(value)).toString("base64url");

describe("Grove browser OIDC", () => {
	it("pins Authorization Code, PKCE, issuer, verified email, and browser-only credentials", () => {
		const plugin = groveOidc({
			issuer: "https://identity.example/realm/grove/",
			clientId: "grove-browser",
			clientSecret: "browser-secret",
			callbackOrigin: "https://grove.example/",
		});
		const provider = plugin.options.config[0];

		expect(provider).toMatchObject({
			providerId: GROVE_OIDC_PROVIDER_ID,
			accountIssuer: "https://identity.example/realm/grove/",
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

	it("completes the callback into a verified-email browser session", async () => {
		const issuer = "https://identity.example/realm/grove";
		const origin = "https://grove.example";
		const keyPair = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
		let expectedNonce = "";
		let emailVerified = true;
		const idToken = async () => {
			const now = Math.floor(Date.now() / 1000);
			const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", kid: "grove-test", typ: "JWT" }))}.${base64Url(
				JSON.stringify({
					iss: issuer,
					aud: "grove-browser",
					sub: "provider-user-1",
					email: "verified@example.com",
					email_verified: emailVerified,
					name: "Verified User",
					nonce: expectedNonce,
					iat: now,
					exp: now + 300,
				}),
			)}`;
			const signature = await crypto.subtle.sign(
				"RSASSA-PKCS1-v1_5",
				keyPair.privateKey,
				new TextEncoder().encode(unsigned),
			);
			return `${unsigned}.${base64Url(signature)}`;
		};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
			if (url === `${issuer}/.well-known/openid-configuration`)
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					userinfo_endpoint: `${issuer}/userinfo`,
					jwks_uri: `${issuer}/jwks`,
					id_token_signing_alg_values_supported: ["RS256"],
				});
			if (url === `${issuer}/jwks`)
				return Response.json({
					keys: [{ ...publicJwk, kid: "grove-test", alg: "RS256", use: "sig" }],
				});
			if (url === `${issuer}/token`) {
				if (!(init?.body instanceof URLSearchParams))
					throw new TypeError("Expected an OAuth token request body");
				expect(init.body.has("code_verifier")).toBe(true);
				return Response.json({
					access_token: "provider-access-token",
					token_type: "Bearer",
					id_token: await idToken(),
				});
			}
			throw new Error(`Unexpected OIDC request: ${url}`);
		};

		try {
			const auth = betterAuth({
				baseURL: origin,
				secret: "test-secret-at-least-thirty-two-characters",
				database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
				emailAndPassword: { enabled: false },
				account: { accountLinking: { enabled: false, disableImplicitLinking: true } },
				plugins: [
					groveOidc({
						issuer,
						clientId: "grove-browser",
						clientSecret: "browser-secret",
						callbackOrigin: origin,
					}),
				],
			});
			const completeAuthorization = async () => {
				const signIn = await auth.api.signInSocial({
					body: { provider: GROVE_OIDC_PROVIDER_ID, callbackURL: "/" },
					asResponse: true,
				});
				const authorizationUrl = new URL(signIn.headers.get("location") ?? "");
				expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
				expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
				expectedNonce = authorizationUrl.searchParams.get("nonce") ?? "";
				expect(expectedNonce).not.toBe("");
				const state = authorizationUrl.searchParams.get("state");
				expect(state).toBeTruthy();

				const stateCookies = signIn.headers
					.getSetCookie()
					.map((cookie) => cookie.split(";", 1)[0])
					.join("; ");
				return auth.handler(
					new Request(
						`${origin}/api/auth/callback/${GROVE_OIDC_PROVIDER_ID}?code=authorization-code&state=${encodeURIComponent(state ?? "")}`,
						{ headers: { cookie: stateCookies } },
					),
				);
			};

			const callback = await completeAuthorization();
			const sessionCookies = callback.headers
				.getSetCookie()
				.map((cookie) => cookie.split(";", 1)[0])
				.join("; ");
			const session = await auth.api.getSession({
				headers: new Headers({ cookie: sessionCookies }),
			});

			expect(session?.user).toMatchObject({
				email: "verified@example.com",
				emailVerified: true,
				name: "Verified User",
			});

			emailVerified = false;
			const unverifiedCallback = await completeAuthorization();
			expect(unverifiedCallback.headers.get("location")).toContain("error=unable_to_get_user_info");
			expect(unverifiedCallback.headers.getSetCookie()).not.toEqual(
				expect.arrayContaining([expect.stringContaining("better-auth.session_token=")]),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
