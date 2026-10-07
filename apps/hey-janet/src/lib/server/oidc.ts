import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
const issuer = () => process.env.OIDC_ISSUER ?? "https://id.petalcat.dev/application/o/hey-janet/";
const schema = z.object({
	issuer: z.string(),
	authorization_endpoint: z.url(),
	token_endpoint: z.url(),
	jwks_uri: z.url(),
});
export async function discovery() {
	const response = await fetch(`${issuer()}.well-known/openid-configuration`, {
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) throw new Error("Identity service unavailable");
	const config = schema.parse(await response.json());
	if (config.issuer !== issuer()) throw new Error("Issuer mismatch");
	for (const address of [config.authorization_endpoint, config.token_endpoint, config.jwks_uri])
		if (new URL(address).origin !== new URL(issuer()).origin)
			throw new Error("Unexpected identity endpoint");
	return config;
}
export async function claims(token: string, jwks: string, nonce: string) {
	const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(jwks)), {
		issuer: issuer(),
		audience: process.env.OIDC_CLIENT_ID,
		algorithms: ["RS256", "ES256"],
		requiredClaims: ["sub", "exp", "iat", "nonce"],
	});
	if (payload.nonce !== nonce) throw new Error("Nonce mismatch");
	return payload;
}
