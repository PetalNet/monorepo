import { BETTER_AUTH_SECRET, BETTER_AUTH_URL } from "$app/env/private";
import { getRequestEvent } from "$app/server";
import * as PgClient from "@effect/sql-pg/PgClient";
import { createEffectQbAdapter } from "@petalnet/better-auth-effect-qb-adapter";
import type { Handle } from "@sveltejs/kit";
import { betterAuth } from "better-auth/minimal";
import { isAuthPath, svelteKitHandler, sveltekitCookies } from "better-auth/svelte-kit";
import { Context, Effect, Layer } from "effect";

const makeAuth = (database: ReturnType<typeof createEffectQbAdapter>) =>
	betterAuth({
		appName: "Grove",
		...(BETTER_AUTH_URL ? { baseURL: BETTER_AUTH_URL } : {}),
		secret: BETTER_AUTH_SECRET,
		database,
		emailAndPassword: { enabled: true },
		plugins: [sveltekitCookies(getRequestEvent)],
	});

type Auth = ReturnType<typeof makeAuth>;

interface GroveAuthShape {
	readonly isAuthPath: (url: string) => Effect.Effect<boolean>;
	readonly getSession: (
		headers: Headers,
	) => Effect.Effect<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
	readonly handle: (input: Parameters<Handle>[0]) => Effect.Effect<Response>;
}

export class GroveAuth extends Context.Service<GroveAuth, GroveAuthShape>()("grove/GroveAuth") {}

const fromAuth = (auth: Auth): GroveAuthShape => ({
	isAuthPath: (url) => Effect.sync(() => isAuthPath(url, auth.options)),
	getSession: (headers) => Effect.promise(() => auth.api.getSession({ headers })),
	handle: ({ event, resolve }) =>
		Effect.promise(() => svelteKitHandler({ event, resolve, auth, building: false })),
});

const unavailableDuringBuild = () => Effect.die("Grove authentication is unavailable during build");

export const GroveAuthBuildLayer = Layer.succeed(GroveAuth, {
	isAuthPath: unavailableDuringBuild,
	getSession: unavailableDuringBuild,
	handle: unavailableDuringBuild,
});

export const GroveAuthLayer = Layer.effect(
	GroveAuth,
	Effect.map(Effect.context<PgClient.PgClient>(), (context) =>
		fromAuth(
			makeAuth(
				createEffectQbAdapter({
					runPromise: (effect) => Effect.runPromise(Effect.provide(effect, context)),
				}),
			),
		),
	),
);
