import {
	BETTER_AUTH_SECRET,
	BETTER_AUTH_URL,
	GROVE_OIDC_CLIENT_ID,
	GROVE_OIDC_CLIENT_SECRET,
	GROVE_OIDC_ISSUER,
} from "$app/env/private";
import { getRequestEvent } from "$app/server";
import * as PgClient from "@effect/sql-pg/PgClient";
import { createEffectQbAdapter } from "@petalnet/better-auth-effect-qb-adapter";
import type { RequestEvent, ResolveOptions } from "@sveltejs/kit";
import type { BetterAuthOptions, Session, User } from "better-auth";
import type { AdapterFactory } from "better-auth/adapters";
import { betterAuth } from "better-auth/minimal";
import { isAuthPath, svelteKitHandler, sveltekitCookies } from "better-auth/svelte-kit";
import { Context, Effect, Layer } from "effect";

import { GROVE_OIDC_PROVIDER_ID, groveOidc } from "./oidc";

const requireRuntimeString = (value: unknown, name: string) => {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${name} is required at runtime`);
	return value;
};

const makeAuth = (database: AdapterFactory<BetterAuthOptions>) => {
	if (!BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is required at runtime");
	const oidcIssuer = requireRuntimeString(GROVE_OIDC_ISSUER, "GROVE_OIDC_ISSUER");
	const oidcClientId = requireRuntimeString(GROVE_OIDC_CLIENT_ID, "GROVE_OIDC_CLIENT_ID");
	const oidcClientSecret = requireRuntimeString(
		GROVE_OIDC_CLIENT_SECRET,
		"GROVE_OIDC_CLIENT_SECRET",
	);

	return betterAuth({
		appName: "Grove",
		baseURL: BETTER_AUTH_URL,
		secret: BETTER_AUTH_SECRET,
		database,
		emailAndPassword: { enabled: false },
		account: {
			accountLinking: {
				enabled: false,
				disableImplicitLinking: true,
			},
		},
		plugins: [
			groveOidc({
				issuer: oidcIssuer,
				clientId: oidcClientId,
				clientSecret: oidcClientSecret,
				callbackOrigin: BETTER_AUTH_URL,
			}),
			sveltekitCookies(getRequestEvent),
		],
	});
};

interface GroveBetterAuth {
	readonly handler: (request: Request) => Promise<Response>;
	readonly options: BetterAuthOptions;
	readonly api: {
		readonly getSession: (input: {
			readonly headers: Headers;
		}) => Promise<{ session: Session; user: User } | null>;
		readonly signInSocial: (input: {
			readonly body: { readonly provider: string; readonly callbackURL: string };
			readonly headers: Headers;
			readonly asResponse: true;
		}) => Promise<Response>;
	};
}

interface GroveAuthShape {
	readonly isAuthPath: (url: string) => Effect.Effect<boolean>;
	readonly getSession: (headers: Headers) => Effect.Effect<{ session: Session; user: User } | null>;
	readonly handle: (input: {
		readonly event: RequestEvent;
		readonly resolve: (
			event: RequestEvent,
			options?: ResolveOptions,
		) => Response | Promise<Response>;
	}) => Effect.Effect<Response>;
	readonly signIn: (headers: Headers) => Effect.Effect<Response>;
}

export class GroveAuth extends Context.Service<GroveAuth, GroveAuthShape>()("grove/GroveAuth") {}

const fromAuth = (auth: GroveBetterAuth): GroveAuthShape => ({
	isAuthPath: (url) => Effect.sync(() => isAuthPath(url, auth.options)),
	getSession: (headers) => Effect.promise(() => auth.api.getSession({ headers })),
	handle: ({ event, resolve }) =>
		Effect.promise(() => svelteKitHandler({ event, resolve, auth, building: false })),
	signIn: (headers) =>
		Effect.promise(() =>
			auth.api.signInSocial({
				body: { provider: GROVE_OIDC_PROVIDER_ID, callbackURL: "/" },
				headers,
				asResponse: true,
			}),
		),
});

const unavailableDuringBuild = () => Effect.die("Grove authentication is unavailable during build");

export const GroveAuthBuildLayer = Layer.succeed(GroveAuth, {
	isAuthPath: unavailableDuringBuild,
	getSession: unavailableDuringBuild,
	handle: unavailableDuringBuild,
	signIn: unavailableDuringBuild,
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
