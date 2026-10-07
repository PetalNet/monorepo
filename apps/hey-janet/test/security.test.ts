import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it } from "vitest";

import { claims, discovery } from "../src/lib/server/oidc";
import { limit, sign, verify } from "../src/lib/server/security";
afterEach(() => {
	delete process.env.OIDC_ISSUER;
	delete process.env.OIDC_CLIENT_ID;
});
it("signed sessions reject tampering and expire", async () => {
	const token = await sign({ id: "test", admin: false });
	expect((await verify(token)).admin).toBe(false);
	await expect(verify(token + "x")).rejects.toThrow();
	await expect(verify(await sign({ id: "test" }, "-1s"))).rejects.toThrow();
});
it("rate limits enforce independent session/IP buckets", () => {
	const key = randomUUID();
	limit(key, 2);
	limit(key, 2);
	expect(() => {
		limit(key, 2);
	}).toThrow();
	expect(() => {
		limit(randomUUID(), 2);
	}).not.toThrow();
});
it("validates OIDC signature, issuer, audience, expiry, nonce and discovery endpoints", async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = await exportJWK(publicKey);
	let base = "";
	let foreign = false;
	const server = createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify(
				req.url === "/jwks"
					? { keys: [{ ...jwk, kid: "test", alg: "RS256" }] }
					: {
							issuer: base,
							authorization_endpoint: foreign ? "https://elsewhere.invalid/auth" : base + "auth",
							token_endpoint: base + "token",
							jwks_uri: base + "jwks",
						},
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	base = `http://127.0.0.1:${String(address.port)}/`;
	process.env.OIDC_ISSUER = base;
	process.env.OIDC_CLIENT_ID = "booth";
	const token = (audience = "booth", expiry = "1m") =>
		new SignJWT({ nonce: "nonce" })
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setSubject("parker")
			.setIssuer(base)
			.setAudience(audience)
			.setIssuedAt()
			.setExpirationTime(expiry)
			.sign(privateKey);
	try {
		expect((await discovery()).issuer).toBe(base);
		expect((await claims(await token(), base + "jwks", "nonce")).sub).toBe("parker");
		await expect(claims(await token(), base + "jwks", "other")).rejects.toThrow();
		await expect(claims(await token("other"), base + "jwks", "nonce")).rejects.toThrow();
		await expect(claims(await token("booth", "-1s"), base + "jwks", "nonce")).rejects.toThrow();
		foreign = true;
		await expect(discovery()).rejects.toThrow("Unexpected identity endpoint");
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((e) => {
				if (e) reject(e);
				else resolve();
			}),
		);
	}
});
