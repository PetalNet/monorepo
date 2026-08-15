import {
	BETTER_AUTH_SECRET,
	BETTER_AUTH_URL,
	GROVE_OIDC_CLIENT_ID,
	GROVE_OIDC_CLIENT_SECRET,
	GROVE_OIDC_ISSUER,
} from "$app/env/private";
import * as PgClient from "@effect/sql-pg/PgClient";
import { createEffectQbAdapter } from "@petalnet/better-auth-effect-qb-adapter";
import { Effect, Layer } from "effect";

import { ActorAuthority } from "./actors/authority";
import { GroveAuth, makeGroveBrowserAuth } from "./auth";

const required = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${name} is required at runtime`);
	return value;
};

export const GroveAuthLayer = Layer.effect(
	GroveAuth,
	Effect.gen(function* () {
		const context = yield* Effect.context<PgClient.PgClient>();
		const sql = yield* PgClient.PgClient;
		const authority = yield* ActorAuthority;
		return yield* Effect.promise(() =>
			makeGroveBrowserAuth(
				{
					baseUrl: required(BETTER_AUTH_URL, "BETTER_AUTH_URL"),
					secret: required(BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET"),
					issuer: required(GROVE_OIDC_ISSUER, "GROVE_OIDC_ISSUER"),
					clientId: required(GROVE_OIDC_CLIENT_ID, "GROVE_OIDC_CLIENT_ID"),
					clientSecret: required(GROVE_OIDC_CLIENT_SECRET, "GROVE_OIDC_CLIENT_SECRET"),
				},
				createEffectQbAdapter({
					runPromise: (effect) => Effect.runPromise(Effect.provide(effect, context)),
				}),
				sql,
				authority,
			),
		);
	}),
);
