import { createPublicKey, type KeyObject } from "node:crypto";

import { Data, Effect, Schema } from "effect";
import {
	calculateJwkThumbprint,
	createRemoteJWKSet,
	decodeJwt,
	exportJWK,
	jwtVerify,
	SignJWT,
} from "jose";

import {
	Claims,
	githubIssuer,
	grant,
	PullRequest,
	sameRepositoryPull,
	type Policy,
} from "./policy.ts";

class Denied extends Data.TaggedError("Denied") {}

export interface Settings extends Policy {
	readonly audience: string;
	readonly issuer: string;
	readonly team: string;
	readonly privateKey: KeyObject;
	readonly providers: ReadonlyMap<string, string>;
	readonly githubToken: string;
}

export const createExchanger = Effect.fn("createExchanger")(function* (
	settings: Settings,
	githubApi: string,
) {
	const jwk = yield* Effect.promise(() => exportJWK(createPublicKey(settings.privateKey)));
	const kid = yield* Effect.promise(() => calculateJwkThumbprint(jwk));
	const keys = new Map(
		[...settings.providers].map(([issuer, url]) => [
			issuer,
			createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cacheMaxAge: 600_000 }),
		]),
	);
	const exchange = Effect.fn("exchange")(function* (token: string) {
		const unverified = yield* Effect.try({
			try: () => decodeJwt(token),
			catch: () => new Denied(),
		});
		const issuer = unverified.iss;
		const key = issuer === undefined ? undefined : keys.get(issuer);

		if (!key || !issuer) {
			return yield* new Denied();
		}

		const verified = yield* Effect.tryPromise({
			try: () =>
				jwtVerify(token, key, {
					issuer,
					audience: settings.audience,
					algorithms: ["RS256", "ES256"],
					requiredClaims: ["exp", "sub", "iat"],
				}),
			catch: () => new Denied(),
		});
		const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload).pipe(
			Effect.mapError(() => new Denied()),
		);
		let sameRepoPull = false;

		if (
			claims.iss === githubIssuer &&
			claims.repository === "PetalNet/monorepo" &&
			claims.event_name === "pull_request"
		) {
			const number = claims.ref?.match(/^refs\/pull\/(\d+)\/merge$/)?.[1];

			if (!number || !settings.githubToken) {
				return yield* new Denied();
			}

			const pull = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(`${githubApi}/repos/PetalNet/monorepo/pulls/${number}`, {
						headers: {
							authorization: `Bearer ${settings.githubToken}`,
							accept: "application/vnd.github+json",
							"X-GitHub-Api-Version": "2022-11-28",
						},
						signal: AbortSignal.timeout(5000),
						redirect: "error",
					});

					if (!response.ok) {
						throw new Denied();
					}

					const body: unknown = await response.json();

					return body;
				},
				catch: () => new Denied(),
			});

			sameRepoPull = sameRepositoryPull(
				yield* Schema.decodeUnknownEffect(PullRequest)(pull).pipe(
					Effect.mapError(() => new Denied()),
				),
			);
		}

		const scope = grant(claims, settings, sameRepoPull);

		if (scope === null) {
			return yield* new Denied();
		}

		const accessToken = yield* Effect.tryPromise({
			try: () =>
				new SignJWT({ scope, teams: [settings.team] })
					.setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
					.setIssuer(settings.issuer)
					.setAudience(settings.audience)
					.setSubject(`${claims.iss}:${claims.sub}`)
					.setIssuedAt()
					.setExpirationTime("2h")
					.sign(settings.privateKey),
			catch: () => new Denied(),
		});

		return {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 7200,
			scope,
			team: settings.team,
		};
	});

	return { jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }, exchange };
});
