import { createPublicKey, type KeyObject } from "node:crypto";

import { Data, Effect, Redacted, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
	calculateJwkThumbprint,
	createRemoteJWKSet,
	decodeJwt,
	exportJWK,
	jwtVerify,
	SignJWT,
	type JSONWebKeySet,
} from "jose";

import {
	Claims,
	githubIssuer,
	grant,
	PullRequest,
	repository,
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
	readonly githubToken: Redacted.Redacted;
}

export interface Exchanger {
	readonly jwks: JSONWebKeySet;
	readonly exchange: (token: string) => Effect.Effect<
		{
			readonly access_token: string;
			readonly token_type: string;
			readonly expires_in: number;
			readonly scope: string;
			readonly team: string;
		},
		Denied
	>;
}

export const createExchanger = Effect.fn("createExchanger")(function* (settings: Settings) {
	const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
	const jwk = yield* Effect.promise(() => exportJWK(createPublicKey(settings.privateKey)));
	const kid = yield* Effect.promise(() => calculateJwkThumbprint(jwk));
	const keys = new Map(
		[...settings.providers].map(([issuer, url]) => [issuer, createRemoteJWKSet(new URL(url))]),
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
			grant(claims, settings, true) === "read" &&
			claims.event_name === "pull_request"
		) {
			const number = claims.ref?.match(/^refs\/pull\/(\d+)\/merge$/)?.[1];

			if (!number || !Redacted.value(settings.githubToken)) {
				return yield* new Denied();
			}

			const pull = yield* client
				.execute(
					HttpClientRequest.get(`https://api.github.com/repos/${repository}/pulls/${number}`).pipe(
						HttpClientRequest.bearerToken(settings.githubToken),
						HttpClientRequest.setHeaders({
							accept: "application/vnd.github+json",
							"X-GitHub-Api-Version": "2022-11-28",
						}),
					),
				)
				.pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(PullRequest)),
					Effect.timeout("5 seconds"),
					Effect.mapError(() => new Denied()),
				);

			sameRepoPull = sameRepositoryPull(pull);
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

	return {
		jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
		exchange,
	} satisfies Exchanger;
});
