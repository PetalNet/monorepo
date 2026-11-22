import { createHash, timingSafeEqual } from "node:crypto";

import { Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { newToken } from "./database";

// PetalBoard's OIDC authorization-code flow, with the same PKCE, nonce and group gates.
const Transaction = Schema.Struct({
	state: Schema.String,
	nonce: Schema.String,
	verifier: Schema.String,
});
const Discovery = Schema.Struct({
	issuer: Schema.String,
	authorization_endpoint: Schema.String,
	token_endpoint: Schema.String,
	jwks_uri: Schema.String,
});
let cached:
	| {
			issuer: string;
			expires: number;
			discovery: typeof Discovery.Type;
			keys: ReturnType<typeof createRemoteJWKSet>;
	  }
	| undefined;

function getOidcConfig() {
	const issuer = process.env.OIDC_ISSUER?.replace(/\/+$/, "");
	const clientId = process.env.OIDC_CLIENT_ID;
	const clientSecret = process.env.OIDC_CLIENT_SECRET;
	const origin = process.env.ORIGIN?.replace(/\/+$/, "");

	if (!issuer || !clientId || !clientSecret || !origin) {
		return null;
	}

	return {
		issuer,
		clientId,
		clientSecret,
		requiredGroup: process.env.OIDC_REQUIRED_GROUP ?? "relics-admins",
		redirectUri: `${origin}/login/oidc/callback`,
	};
}

export const sameOidcValue = (value: string, expected: string) => {
	const a = Buffer.from(value);
	const b = Buffer.from(expected);

	return a.length === b.length && timingSafeEqual(a, b);
};

export function decodeTransaction(value?: string) {
	if (!value) {
		return null;
	}

	try {
		return Schema.decodeUnknownSync(Transaction)(
			JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
		);
	} catch {
		return null;
	}
}

async function discover(issuer: string) {
	if (cached?.issuer === issuer && cached.expires > Date.now()) {
		return cached;
	}

	const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
		signal: AbortSignal.timeout(10000),
	});

	if (!response.ok) {
		throw new Error("OIDC discovery unavailable");
	}

	const discovery = Schema.decodeUnknownSync(Discovery)(await response.json());

	if (
		discovery.issuer.replace(/\/+$/, "") !== issuer ||
		[discovery.authorization_endpoint, discovery.token_endpoint, discovery.jwks_uri].some(
			(url) => new URL(url).protocol !== "https:",
		)
	) {
		throw new Error("Invalid OIDC discovery");
	}

	cached = {
		issuer,
		discovery,
		expires: Date.now() + 300000,
		keys: createRemoteJWKSet(new URL(discovery.jwks_uri)),
	};

	return cached;
}

export async function beginOidcLogin() {
	const config = getOidcConfig();

	if (!config) {
		throw new Error("OIDC not configured");
	}

	const { discovery } = await discover(config.issuer);
	const transaction = { state: newToken(), nonce: newToken(), verifier: newToken() };
	const url = new URL(discovery.authorization_endpoint);

	url.search = new URLSearchParams({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		scope: "openid profile email",
		state: transaction.state,
		nonce: transaction.nonce,
		code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();

	return {
		url: url.toString(),
		transaction: Buffer.from(JSON.stringify(transaction)).toString("base64url"),
	};
}

export async function exchangeOidcCode(code: string, transaction: typeof Transaction.Type) {
	const config = getOidcConfig();

	if (!config) {
		throw new Error("OIDC not configured");
	}

	const { discovery, keys } = await discover(config.issuer);
	const response = await fetch(discovery.token_endpoint, {
		method: "POST",
		signal: AbortSignal.timeout(10000),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: config.redirectUri,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code_verifier: transaction.verifier,
		}),
	});

	if (!response.ok) {
		return null;
	}

	try {
		const { id_token } = Schema.decodeUnknownSync(Schema.Struct({ id_token: Schema.String }))(
			await response.json(),
		);
		const { payload } = await jwtVerify(id_token, keys, {
			issuer: discovery.issuer,
			audience: config.clientId,
			algorithms: ["RS256", "ES256"],
			requiredClaims: ["exp", "iat", "sub", "nonce"],
			clockTolerance: 30,
		});

		if (
			typeof payload.nonce !== "string" ||
			!sameOidcValue(payload.nonce, transaction.nonce) ||
			!payload.sub ||
			!Array.isArray(payload.groups) ||
			!payload.groups.includes(config.requiredGroup) ||
			(Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
		) {
			return null;
		}

		return { subject: payload.sub };
	} catch {
		return null;
	}
}
