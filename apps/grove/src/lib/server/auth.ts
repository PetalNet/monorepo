import { building, dev } from "$app/env";
import { BETTER_AUTH_SECRET, BETTER_AUTH_URL } from "$app/env/private";
import { getRequestEvent } from "$app/server";
import * as PgClient from "@effect/sql-pg/PgClient";
import { createEffectQbAdapter } from "@petalnet/better-auth-effect-qb-adapter";
import { betterAuth } from "better-auth/minimal";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { Context, Effect, Layer } from "effect";

const configuredSecret = BETTER_AUTH_SECRET?.trim();
if (!configuredSecret && !building && !dev)
	throw new Error("Missing required authentication setting: BETTER_AUTH_SECRET");
const secret = configuredSecret || "grove-development-secret-at-least-32-characters";

const makeAuth = (database: ReturnType<typeof createEffectQbAdapter>) =>
	betterAuth({
		appName: "Grove",
		...(BETTER_AUTH_URL ? { baseURL: BETTER_AUTH_URL } : {}),
		secret,
		database,
		emailAndPassword: { enabled: true },
		plugins: [sveltekitCookies(getRequestEvent)],
	});

export class GroveAuth extends Context.Service<GroveAuth, ReturnType<typeof makeAuth>>()(
	"grove/GroveAuth",
) {}

export const GroveAuthLayer = Layer.effect(
	GroveAuth,
	Effect.map(Effect.context<PgClient.PgClient>(), (context) =>
		makeAuth(
			createEffectQbAdapter({
				runPromise: (effect) => Effect.runPromise(Effect.provide(effect, context)),
			}),
		),
	),
);
