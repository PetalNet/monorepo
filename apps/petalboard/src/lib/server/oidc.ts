import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PrismaClient, User } from "./generated/prisma/client";

const DISCOVERY_TTL_MS = 5 * 60 * 1000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface Discovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
}

interface OidcTransaction {
	state: string;
	nonce: string;
	verifier: string;
}

interface IdTokenClaims {
	iss: string;
	aud: string | string[];
	azp?: string;
	exp: number;
	nonce: string;
	sub: string;
	email?: string;
	email_verified?: boolean;
	groups?: unknown;
	name?: string;
	preferred_username?: string;
}

let cachedDiscovery: { issuer: string; value: Discovery; expiresAt: number } | undefined;

function config() {
	const issuer = process.env.OIDC_ISSUER?.replace(/\/+$/, "");
	const clientId = process.env.OIDC_CLIENT_ID;
	const clientSecret = process.env.OIDC_CLIENT_SECRET;
	const origin = process.env.ORIGIN || process.env.APP_URL;

	if (!issuer || !clientId || !clientSecret || !origin) {
		return null;
	}

	return {
		issuer,
		clientId,
		clientSecret,
		requiredGroup: process.env.OIDC_REQUIRED_GROUP || "petalboard-hosts",
		redirectUri: `${origin.replace(/\/$/, "")}/login/oidc/callback`,
	};
}

export function getOidcConfig() {
	return config();
}

export function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

function encodeTransaction(transaction: OidcTransaction): string {
	return Buffer.from(JSON.stringify(transaction)).toString("base64url");
}

export function decodeTransaction(value: string | undefined): OidcTransaction | null {
	if (!value) {
		return null;
	}

	try {
		const transaction = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as OidcTransaction;

		return typeof transaction.state === "string" &&
			typeof transaction.nonce === "string" &&
			typeof transaction.verifier === "string"
			? transaction
			: null;
	} catch {
		return null;
	}
}

export function sameOidcValue(value: string, expected: string): boolean {
	const actualBuffer = Buffer.from(value);
	const expectedBuffer = Buffer.from(expected);

	return (
		actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
	);
}

async function discover(issuer: string, fetcher: Fetcher): Promise<Discovery> {
	if (cachedDiscovery?.issuer === issuer && cachedDiscovery.expiresAt > Date.now()) {
		return cachedDiscovery.value;
	}

	const response = await fetcher(`${issuer}/.well-known/openid-configuration`);

	if (!response.ok) {
		throw new Error("OIDC discovery failed");
	}

	const value = (await response.json()) as Partial<Discovery>;

	if (
		typeof value.issuer !== "string" ||
		typeof value.authorization_endpoint !== "string" ||
		typeof value.token_endpoint !== "string"
	) {
		throw new TypeError("OIDC discovery response is invalid");
	}

	cachedDiscovery = { issuer, value: value as Discovery, expiresAt: Date.now() + DISCOVERY_TTL_MS };

	return cachedDiscovery.value;
}

export async function beginOidcLogin(fetcher: Fetcher = fetch) {
	const oidc = config();

	if (!oidc) {
		throw new Error("OIDC is not configured");
	}

	const discovery = await discover(oidc.issuer, fetcher);
	const transaction = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		verifier: randomBytes(32).toString("base64url"),
	};
	const url = new URL(discovery.authorization_endpoint);

	url.search = new URLSearchParams({
		response_type: "code",
		client_id: oidc.clientId,
		redirect_uri: oidc.redirectUri,
		scope: "openid profile email",
		state: transaction.state,
		nonce: transaction.nonce,
		code_challenge: pkceChallenge(transaction.verifier),
		code_challenge_method: "S256",
	}).toString();

	return { url: url.toString(), transaction: encodeTransaction(transaction) };
}

function parseIdToken(token: string): IdTokenClaims | null {
	const [, payload] = token.split(".");

	if (!payload) {
		return null;
	}

	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IdTokenClaims;
	} catch {
		return null;
	}
}

export async function exchangeOidcCode(
	code: string,
	transaction: OidcTransaction,
	fetcher: Fetcher = fetch,
): Promise<IdTokenClaims | null> {
	const oidc = config();

	if (!oidc) {
		throw new Error("OIDC is not configured");
	}

	const discovery = await discover(oidc.issuer, fetcher);
	const response = await fetcher(discovery.token_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: oidc.redirectUri,
			client_id: oidc.clientId,
			client_secret: oidc.clientSecret,
			code_verifier: transaction.verifier,
		}),
	});

	if (!response.ok) {
		return null;
	}

	const body = (await response.json()) as { id_token?: unknown };

	if (typeof body.id_token !== "string") {
		return null;
	}

	const claims = parseIdToken(body.id_token);

	if (
		!claims ||
		!sameOidcValue(claims.iss, discovery.issuer) ||
		!sameOidcValue(claims.nonce, transaction.nonce)
	) {
		return null;
	}

	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

	if (
		!audiences.includes(oidc.clientId) ||
		(audiences.length > 1 && claims.azp !== oidc.clientId)
	) {
		return null;
	}

	if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000) - 60) {
		return null;
	}

	if (
		typeof claims.sub !== "string" ||
		typeof claims.email !== "string" ||
		// Authentik's default mapping hard-codes this false; group membership gates access.
		!Array.isArray(claims.groups) ||
		!claims.groups.includes(oidc.requiredGroup)
	) {
		return null;
	}

	claims.email = claims.email.trim().toLowerCase();

	return claims.email ? claims : null;
}

export async function findOrCreateOidcUser(
	database: PrismaClient,
	claims: Required<Pick<IdTokenClaims, "sub" | "email">> &
		Pick<IdTokenClaims, "name" | "preferred_username">,
): Promise<Pick<User, "id" | "email" | "oidcSubject"> | null> {
	const bySubject = await database.user.findUnique({ where: { oidcSubject: claims.sub } });

	if (bySubject) {
		return bySubject;
	}

	const [byEmail] = await database.$queryRaw<Pick<User, "id" | "email" | "oidcSubject">[]>`
		SELECT id, email, oidcSubject FROM User WHERE lower(email) = lower(${claims.email})
	`;

	if (byEmail) {
		if (byEmail.oidcSubject) {
			return null;
		}

		return database.user.update({
			where: { id: byEmail.id },
			data: { oidcSubject: claims.sub, emailVerified: true },
		});
	}

	const localPart = claims.email.slice(0, claims.email.indexOf("@"));

	return database.user.create({
		data: {
			email: claims.email,
			name: claims.name?.trim() || claims.preferred_username?.trim() || localPart,
			passwordHash: "!oidc-only",
			emailVerified: true,
			oidcSubject: claims.sub,
		},
	});
}
