import * as PgClient from "@effect/sql-pg/PgClient";
import { createEffectQbAdapter } from "@petalnet/better-auth-effect-qb-adapter";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ActorAuthority, ActorAuthorityLayer } from "../src/lib/server/actors/authority";
import { makeGroveBrowserAuth } from "../src/lib/server/auth";
import { GROVE_OIDC_PROVIDER_ID } from "../src/lib/server/oidc";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

const issuer = "https://identity.example/realm/grove";
const origin = "https://grove.example";
const owner = { issuer, subject: "provider-owner-1" };
const eventFor = (request: Request) =>
	({
		request,
		url: new URL(request.url),
		locals: { actor: null, session: null, user: null },
		cookies: { set: () => undefined },
	}) as unknown as RequestEvent;

describe("production Grove browser auth composition", () => {
	let runtime: ManagedRuntime.ManagedRuntime<ActorAuthority | PgClient.PgClient, unknown>;
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		const postgres = await startGrovePostgres();
		const database = PgClient.layer({ url: Redacted.make(postgres.databaseUrl) });
		const actors = ActorAuthorityLayer({ homeOwner: owner }).pipe(Layer.provideMerge(database));
		runtime = ManagedRuntime.make(actors);
		originalFetch = globalThis.fetch;
	}, 60_000);

	afterAll(async () => {
		globalThis.fetch = originalFetch;
		await runtime.dispose();
		await stopGrovePostgres();
	});

	it("blocks direct token sign-in and completes code callback into a durable Person session", async () => {
		const pair = await generateKeyPair("RS256");
		const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "browser-test", alg: "RS256" };
		let expectedNonce = "";
		let includeIssuedAt = true;
		let emailVerified = true;
		let audience: string | string[] = "grove-browser";
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
			if (url === `${issuer}/jwks`) return Response.json({ keys: [publicJwk] });
			if (url === `${issuer}/token`) {
				const body = init?.body;
				expect(body).toBeInstanceOf(URLSearchParams);
				if (!(body instanceof URLSearchParams)) throw new TypeError("Expected OAuth form body");
				expect(body.has("code_verifier")).toBe(true);
				const now = Math.floor(Date.now() / 1000);
				const token = new SignJWT({
					email: "operator@example.com",
					email_verified: emailVerified,
					name: "Grove Operator",
					nonce: expectedNonce,
				})
					.setProtectedHeader({ alg: "RS256", kid: "browser-test" })
					.setIssuer(issuer)
					.setAudience(audience)
					.setSubject(owner.subject)
					.setExpirationTime(now + 300);
				if (includeIssuedAt) token.setIssuedAt(now);
				const idToken = await token.sign(pair.privateKey);
				return Response.json({
					access_token: "provider-access-token",
					token_type: "Bearer",
					id_token: idToken,
				});
			}
			throw new Error(`Unexpected OIDC request: ${url}`);
		};

		let activeEvent: RequestEvent;
		const sql = await runtime.runPromise(PgClient.PgClient);
		const authority = await runtime.runPromise(ActorAuthority);
		const browserAuth = await makeGroveBrowserAuth(
			{
				baseUrl: origin,
				secret: "production-composition-secret-at-least-32-characters",
				issuer,
				clientId: "grove-browser",
				clientSecret: "browser-secret",
			},
			createEffectQbAdapter({ runPromise: (effect) => runtime.runPromise(effect) }),
			sql,
			authority,
			() => activeEvent,
		);
		expect(
			await Effect.runPromise(
				browserAuth.isBrowserAuthRoute("http://grove.example/api/auth/get-session"),
			),
		).toBe(true);
		const beginAuthorization = async (callbackURL = "/") => {
			activeEvent = eventFor(new Request(`${origin}/login`));
			const loginResponse = await Effect.runPromise(
				browserAuth.beginLogin(new Headers(), callbackURL),
			);
			const url = new URL(loginResponse.headers.get("location") ?? "");
			expectedNonce = url.searchParams.get("nonce") ?? "";
			return { loginResponse, url };
		};
		const completeAuthorization = async (loginResponse: Response, url: URL) => {
			const stateCookies = loginResponse.headers
				.getSetCookie()
				.map((cookie) => cookie.split(";", 1)[0])
				.join("; ");
			const callbackRequest = new Request(
				`${origin}/api/auth/callback/${GROVE_OIDC_PROVIDER_ID}?code=authorization-code&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
				{ headers: { cookie: stateCookies } },
			);
			activeEvent = eventFor(callbackRequest);
			return Effect.runPromise(
				browserAuth.dispatch({ event: activeEvent, resolve: () => new Response() }),
			);
		};

		expect(await runtime.runPromise(browserAuth.readiness)).toMatchObject({
			status: "owner-unbound",
		});
		const { loginResponse: login, url: authorizationUrl } =
			await beginAuthorization("/sprouts?view=agent");
		expect(login.status).toBe(302);
		expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(expectedNonce).not.toBe("");

		const directRequest = new Request(`${origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: GROVE_OIDC_PROVIDER_ID, idToken: { token: "fabricated" } }),
		});
		activeEvent = eventFor(directRequest);
		const direct = await Effect.runPromise(
			browserAuth.dispatch({ event: activeEvent, resolve: () => new Response() }),
		);
		expect(direct.status).toBe(404);

		const callback = await completeAuthorization(login, authorizationUrl);
		expect(callback.headers.get("location")).toBe("/sprouts?view=agent");
		const sessionCookies = callback.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";", 1)[0])
			.join("; ");
		const hydrated = await runtime.runPromise(
			browserAuth.hydrateSession(new Headers({ cookie: sessionCookies })),
		);

		expect(hydrated).toMatchObject({
			user: { email: "operator@example.com", emailVerified: true },
			actor: { kind: "person", name: "Grove Operator" },
		});
		expect(await runtime.runPromise(browserAuth.readiness)).toMatchObject({
			status: "ready",
			ownerPersonId: hydrated?.actor.actorId,
		});
		const accounts = await runtime.runPromise(
			sql.unsafe<{ accessToken: string | null; idToken: string | null }>(
				`select "accessToken", "idToken" from "account"`,
			),
		);
		expect(accounts[0]?.accessToken).toEqual(expect.any(String));
		expect(accounts[0]?.accessToken).not.toBe("provider-access-token");
		expect(accounts[0]?.idToken).toBeNull();

		activeEvent = eventFor(
			new Request(`${origin}/__dev/log-me-out`, { headers: { cookie: sessionCookies } }),
		);
		const signedOut = await Effect.runPromise(
			browserAuth.endSession(new Headers({ cookie: sessionCookies }), "/signed-out"),
		);
		expect(signedOut.status).toBe(302);
		expect(signedOut.headers.get("location")).toBe("/signed-out");
		expect(signedOut.headers.getSetCookie().join("\n")).toMatch(
			/(?:__Secure-)?better-auth\.session_token=;.*Max-Age=0/i,
		);
		await expect(
			runtime.runPromise(browserAuth.hydrateSession(new Headers({ cookie: sessionCookies }))),
		).resolves.toBeNull();

		includeIssuedAt = false;
		const missingIssuedAt = await beginAuthorization();
		const rejectedMissingIssuedAt = await completeAuthorization(
			missingIssuedAt.loginResponse,
			missingIssuedAt.url,
		);
		expect(rejectedMissingIssuedAt.headers.get("location")).toContain("unable_to_get_user_info");

		includeIssuedAt = true;
		audience = ["grove-browser", "another-client"];
		const missingAuthorizedParty = await beginAuthorization();
		const rejectedMissingAuthorizedParty = await completeAuthorization(
			missingAuthorizedParty.loginResponse,
			missingAuthorizedParty.url,
		);
		expect(rejectedMissingAuthorizedParty.headers.get("location")).toContain(
			"unable_to_get_user_info",
		);

		audience = "grove-browser";
		emailVerified = false;
		const unverifiedEmail = await beginAuthorization();
		const rejectedUnverifiedEmail = await completeAuthorization(
			unverifiedEmail.loginResponse,
			unverifiedEmail.url,
		);
		expect(rejectedUnverifiedEmail.headers.get("location")).toContain("unable_to_get_user_info");
	}, 60_000);

	it("fails construction when OIDC discovery does not match the pinned issuer", async () => {
		globalThis.fetch = (input) => {
			const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
			if (url !== `${issuer}/.well-known/openid-configuration`)
				throw new Error(`Unexpected OIDC request: ${url}`);
			return Promise.resolve(
				Response.json({
					issuer: "https://unexpected-identity.example/realm/grove",
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					jwks_uri: `${issuer}/jwks`,
					id_token_signing_alg_values_supported: ["RS256"],
				}),
			);
		};
		const sql = await runtime.runPromise(PgClient.PgClient);
		const authority = await runtime.runPromise(ActorAuthority);

		await expect(
			makeGroveBrowserAuth(
				{
					baseUrl: origin,
					secret: "production-composition-secret-at-least-32-characters",
					issuer,
					clientId: "grove-browser",
					clientSecret: "browser-secret",
				},
				createEffectQbAdapter({ runPromise: (effect) => runtime.runPromise(effect) }),
				sql,
				authority,
			),
		).rejects.toThrow("pinned issuer");
	});
});
