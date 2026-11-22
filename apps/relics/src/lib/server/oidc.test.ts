import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import { beginOidcLogin, decodeTransaction, exchangeOidcCode, sameOidcValue } from "./oidc";

const issuer = "https://oidc.example.invalid/application/o/relics";
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
	const { privateKey, publicKey } = await generateKeyPair("RS256");
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
			if (url.endsWith("openid-configuration"))
				return Response.json({
					issuer,
					authorization_endpoint: "https://oidc.example.invalid/authorize",
					token_endpoint: "https://oidc.example.invalid/token",
					jwks_uri: "https://oidc.example.invalid/jwks",
				});
			if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
			if (url.endsWith("/token")) {
				expect(String(init?.body)).toContain("code_verifier=");
				const token = await new SignJWT({ nonce, groups: ["relics-admins"], ...overrides })
					.setProtectedHeader({ alg: "RS256", kid: "test-signing-key" })
					.setIssuer(issuer)
					.setAudience("test-client")
					.setSubject("admin-subject")
					.setIssuedAt()
					.setExpirationTime("5m")
					.sign(privateKey);
				return Response.json({ id_token: token });
			}
			throw new Error("Unexpected network request");
		}),
	);
	const login = await beginOidcLogin();
	const transaction = decodeTransaction(login.transaction);
	if (!transaction) throw new Error("Missing transaction");
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
