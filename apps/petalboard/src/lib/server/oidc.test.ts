import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "./generated/prisma/client";
import {
	beginOidcLogin,
	exchangeOidcCode,
	findOrCreateOidcUser,
	pkceChallenge,
	sameOidcValue,
} from "./oidc";

process.env.ORIGIN = "https://board.example.test";
process.env.OIDC_ISSUER = "https://auth.example.test/application/o/petalboard/";
process.env.OIDC_CLIENT_ID = "petalboard";
process.env.OIDC_CLIENT_SECRET = "secret";
process.env.OIDC_REQUIRED_GROUP = "petalboard-hosts";

const dir = mkdtempSync(path.join(tmpdir(), "petalboard-oidc-"));
const databaseUrl = `file:${path.join(dir, "test.db")}`;
let prisma: PrismaClient;

const issuer = "https://auth.example.test/application/o/petalboard";
const discovery = {
	issuer,
	authorization_endpoint: "https://auth.example.test/authorize",
	token_endpoint: "https://auth.example.test/token",
};

function token(claims: Record<string, unknown>) {
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function oidcFetch(idToken?: string) {
	return vi.fn(async (input: string | URL) => {
		if (String(input).includes(".well-known/")) {
			return Response.json(discovery);
		}

		return Response.json({ id_token: idToken });
	});
}

const validClaims = {
	iss: issuer,
	aud: "petalboard",
	exp: Math.floor(Date.now() / 1000) + 600,
	nonce: "nonce",
	sub: "subject",
	email: " Host@Example.test ",
	email_verified: false,
	groups: ["petalboard-hosts"],
};

describe("OIDC login", () => {
	it("uses an S256 challenge and redirects with all authorization parameters", async () => {
		const fetcher = oidcFetch();
		const result = await beginOidcLogin(fetcher);
		const url = new URL(result.url);
		const transaction = JSON.parse(Buffer.from(result.transaction, "base64url").toString("utf8"));

		expect(pkceChallenge(transaction.verifier)).toBe(
			createHash("sha256").update(transaction.verifier).digest("base64url"),
		);

		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			response_type: "code",
			client_id: "petalboard",
			redirect_uri: "https://board.example.test/login/oidc/callback",
			scope: "openid profile email",
			state: transaction.state,
			nonce: transaction.nonce,
			code_challenge_method: "S256",
			code_challenge: pkceChallenge(transaction.verifier),
		});
	});

	it.each([
		["wrong nonce", { nonce: "wrong" }],
		["wrong audience", { aud: "another-client" }],
		["wrong issuer", { iss: "https://elsewhere.example.test" }],
		["expired token", { exp: Math.floor(Date.now() / 1000) - 61 }],
		["missing group", { groups: [] }],
	])("rejects a %s", async (_, change) => {
		const fetcher = oidcFetch(token({ ...validClaims, ...change }));

		expect(
			await exchangeOidcCode(
				"code",
				{ state: "state", nonce: "nonce", verifier: "verifier" },
				fetcher,
			),
		).toBeNull();
	});

	it("accepts Authentik's default unverified-email claim when the user is in the required group", async () => {
		const fetcher = oidcFetch(token(validClaims));

		expect(
			await exchangeOidcCode(
				"code",
				{ state: "state", nonce: "nonce", verifier: "verifier" },
				fetcher,
			),
		).toMatchObject({
			email: "host@example.test",
			sub: "subject",
		});
	});

	it("does not exchange a callback with bogus state", async () => {
		const fetcher = oidcFetch();

		expect(sameOidcValue("bogus", "expected-state")).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe("OIDC user mapping", () => {
	beforeAll(async () => {
		execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
			env: { ...process.env, DATABASE_URL: databaseUrl },
			stdio: "ignore",
		});

		prisma = new PrismaClient({ datasourceUrl: databaseUrl });
	});

	afterAll(async () => {
		await prisma?.$disconnect();
		rmSync(dir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		await prisma.user.deleteMany();
	});

	it("maps OIDC users against real SQLite without disturbing existing data", async () => {
		const existing = await prisma.user.create({
			data: {
				email: "Host@Example.test",
				name: "Host",
				passwordHash: "password",
				spotifyAccessToken: "access-token",
				spotifyRefreshToken: "refresh-token",
			},
		});
		const event = await prisma.event.create({
			data: {
				title: "Garden party",
				date: new Date("2026-11-26T18:00:00Z"),
				publicCode: "oidc-event",
				manageToken: "oidc-manage-token",
				userId: existing.id,
			},
		});

		const linked = await findOrCreateOidcUser(prisma, {
			sub: "subject",
			email: "host@example.test",
		});

		expect(linked?.id).toBe(existing.id);

		expect(await prisma.user.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
			spotifyAccessToken: "access-token",
			spotifyRefreshToken: "refresh-token",
			oidcSubject: "subject",
		});

		expect(await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			userId: existing.id,
		});

		expect(
			(await findOrCreateOidcUser(prisma, { sub: "subject", email: "changed@example.test" }))?.id,
		).toBe(existing.id);

		const created = await findOrCreateOidcUser(prisma, {
			sub: "new-subject",
			email: "new@example.test",
		});

		if (!created) {
			throw new Error("expected an OIDC user to be created");
		}

		expect(await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
			passwordHash: "!oidc-only",
			oidcSubject: "new-subject",
		});

		await prisma.user.create({
			data: {
				email: "bound@example.test",
				name: "Bound",
				passwordHash: "password",
				oidcSubject: "other-subject",
			},
		});

		expect(
			await findOrCreateOidcUser(prisma, { sub: "different-subject", email: "bound@example.test" }),
		).toBeNull();
	});
});
