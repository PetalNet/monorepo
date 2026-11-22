import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import { beginOidcLogin, decodeTransaction, exchangeOidcCode, sameOidcValue } from "./oidc";

const issuer = "https://oidc.example.invalid/application/o/relics/";
const keyPair = generateKeyPair("RS256");

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function fixture(overrides: Record<string, unknown> = {}) {
	vi.stubEnv("OIDC_ISSUER", issuer);
	vi.stubEnv("OIDC_CLIENT_ID", "test-client");
	vi.stubEnv("OIDC_CLIENT_SECRET", "test-only");
	vi.stubEnv("ORIGIN", "https://relics.example.invalid");
	vi.stubEnv("OIDC_REQUIRED_GROUP", "relics-admins");
	const { privateKey, publicKey } = await keyPair;
	let nonce = "nonce";
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "test-signing-key",
		alg: "RS256",
		use: "sig",
	};

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input);

			if (url.endsWith("openid-configuration")) {
				return Response.json({
					issuer,
					authorization_endpoint: "https://oidc.example.invalid/authorize",
					token_endpoint: "https://oidc.example.invalid/token",
					jwks_uri: "https://oidc.example.invalid/jwks",
				});
			}

			if (url.endsWith("/jwks")) {
				return Response.json({ keys: [jwk] });
			}

			if (url.endsWith("/token")) {
				expect(init?.body instanceof URLSearchParams ? init.body.toString() : "").toContain(
					"code_verifier=",
				);

				const token = await new SignJWT({ nonce, groups: ["relics-admins"], ...overrides })
					.setProtectedHeader({ alg: "RS256", kid: "test-signing-key" })
					.setIssuer(issuer)
					.setAudience(typeof overrides.aud === "string" ? overrides.aud : "test-client")
					.setSubject("admin-subject")
					.setIssuedAt()
					.setExpirationTime(typeof overrides.exp === "number" ? overrides.exp : "5m")
					.sign(privateKey);

				return Response.json({ id_token: token });
			}

			throw new Error("Unexpected network request");
		}),
	);

	const login = await beginOidcLogin();
	const transaction = decodeTransaction(login.transaction);

	if (!transaction) {
		throw new Error("Missing transaction");
	}

	nonce = transaction.nonce;

	return { login, transaction };
}

it("binds the authorization-code flow to state, PKCE, nonce and an exact callback", async () => {
	const { login, transaction } = await fixture();
	const url = new URL(login.url);

	expect(url.searchParams.get("redirect_uri")).toBe(
		"https://relics.example.invalid/login/oidc/callback",
	);

	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(sameOidcValue(transaction.state, url.searchParams.get("state") ?? "")).toBe(true);
	expect(sameOidcValue(transaction.state, "wrong")).toBe(false);
	expect(decodeTransaction("broken")).toBeNull();
	expect(await exchangeOidcCode("test-code", transaction)).toEqual({ subject: "admin-subject" });
});

it("rejects a signed token without the authorized group", async () => {
	const { transaction } = await fixture({ groups: ["collectors"] });

	expect(await exchangeOidcCode("test-code", transaction)).toBeNull();
});

it("rejects a signed token with the wrong nonce", async () => {
	const { transaction } = await fixture({ nonce: "another-transaction" });

	expect(await exchangeOidcCode("test-code", transaction)).toBeNull();
});

it("returns an authorization rejection for expired or wrong-audience signed tokens", async () => {
	let fixtureValue = await fixture({ exp: 1 });

	expect(await exchangeOidcCode("test-code", fixtureValue.transaction)).toBeNull();
	fixtureValue = await fixture({ aud: "another-client" });
	expect(await exchangeOidcCode("test-code", fixtureValue.transaction)).toBeNull();
});

it("accepts either lab administrators or the dedicated relics group", async () => {
	for (const groups of [["authentik Admins"], ["relics-admins"]]) {
		const { transaction } = await fixture({ groups });

		vi.stubEnv("OIDC_REQUIRED_GROUP", "authentik Admins");
		expect(await exchangeOidcCode("test-code", transaction)).toEqual({ subject: "admin-subject" });
	}
});

it("honors a configured dedicated group without granting similarly named groups", async () => {
	const { transaction } = await fixture({ groups: ["snail-staff"] });

	vi.stubEnv("RELICS_ADMIN_GROUP", "snail-staff");
	expect(await exchangeOidcCode("test-code", transaction)).toEqual({ subject: "admin-subject" });
	vi.stubEnv("RELICS_ADMIN_GROUP", "snail");
	expect(await exchangeOidcCode("test-code", transaction)).toBeNull();
});
