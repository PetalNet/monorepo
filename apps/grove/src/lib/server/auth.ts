import { getRequestEvent } from "$app/server";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { RequestEvent, ResolveOptions } from "@sveltejs/kit";
import type { BetterAuthOptions, Session, User } from "better-auth";
import type { AdapterFactory } from "better-auth/adapters";
import { betterAuth } from "better-auth/minimal";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { Context, Effect, Layer } from "effect";

import { ActorAuthority, type PersonPrincipal } from "./actors/authority";
import { GROVE_OIDC_PROVIDER_ID, groveOidc } from "./oidc";

export interface GroveBrowserAuthConfig {
	readonly baseUrl: string;
	readonly secret: string;
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
}

export interface BrowserSession {
	readonly session: Session;
	readonly user: User;
	readonly actor: PersonPrincipal;
}

interface GroveAuthShape {
	readonly isBrowserAuthRoute: (url: string) => Effect.Effect<boolean>;
	readonly hydrateSession: (headers: Headers) => Effect.Effect<BrowserSession | null, unknown>;
	readonly dispatch: (input: {
		readonly event: RequestEvent;
		readonly resolve: (
			event: RequestEvent,
			options?: ResolveOptions,
		) => Response | Promise<Response>;
	}) => Effect.Effect<Response>;
	readonly beginLogin: (headers: Headers) => Effect.Effect<Response>;
	readonly readiness: ActorAuthority["Service"]["homeReadiness"];
}

export class GroveAuth extends Context.Service<GroveAuth, GroveAuthShape>()("grove/GroveAuth") {}

type Sql = PgClient.PgClient;
type Authority = ActorAuthority["Service"];
const isBrowserAuthPath = (url: string) => new URL(url).pathname.startsWith("/api/auth/");

export const makeGroveBrowserAuth = async (
	config: GroveBrowserAuthConfig,
	database: AdapterFactory<BetterAuthOptions>,
	sql: Sql,
	authority: Authority,
	requestEvent: () => RequestEvent = getRequestEvent,
): Promise<GroveAuthShape> => {
	const issuer = config.issuer.replace(/\/+$/, "");
	const auth = betterAuth({
		appName: "Grove",
		baseURL: config.baseUrl,
		secret: config.secret,
		database,
		emailAndPassword: { enabled: false },
		account: {
			encryptOAuthTokens: true,
			accountLinking: { enabled: false, disableImplicitLinking: true },
		},
		databaseHooks: {
			account: {
				create: {
					before: (account) => Promise.resolve({ data: { ...account, idToken: null } }),
				},
				update: {
					before: (account) => Promise.resolve({ data: { ...account, idToken: null } }),
				},
			},
		},
		plugins: [
			groveOidc({
				issuer,
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				callbackOrigin: config.baseUrl,
			}),
			sveltekitCookies(requestEvent),
		],
	});

	// Generic OIDC discovery is part of constructing Grove auth, so bad discovery fails startup.
	await auth.$context;

	return {
		isBrowserAuthRoute: (url) => Effect.sync(() => isBrowserAuthPath(url)),
		hydrateSession: (headers) =>
			Effect.gen(function* () {
				const current = yield* Effect.promise(() => auth.api.getSession({ headers }));
				if (!current?.user.emailVerified) return null;
				const accounts = yield* sql.unsafe<{ issuer: string; subject: string }>(
					`select "issuer", "providerAccountId" as subject
             from "account"
            where "userId" = $1 and "providerId" = $2 and "issuer" = $3`,
					[current.user.id, GROVE_OIDC_PROVIDER_ID, issuer],
				);
				const account = accounts.at(0);
				if (!account || accounts.length !== 1) return null;
				const actor = yield* authority.bindBrowserIdentity({
					authUserId: current.user.id,
					issuer: account.issuer,
					subject: account.subject,
					name: current.user.name,
					emailVerified: current.user.emailVerified,
				});
				return { ...current, actor };
			}),
		dispatch: ({ event, resolve }) => {
			if (event.request.method === "POST" && event.url.pathname === "/api/auth/sign-in/social")
				return Effect.succeed(new Response("Not found", { status: 404 }));
			if (isBrowserAuthPath(event.url.toString()))
				return Effect.promise(() => auth.handler(event.request));
			return Effect.promise(() => Promise.resolve(resolve(event)));
		},
		beginLogin: (headers) =>
			Effect.promise(async () => {
				const initiated = await auth.api.signInSocial({
					body: { provider: GROVE_OIDC_PROVIDER_ID, callbackURL: "/" },
					headers,
					asResponse: true,
				});
				const location = initiated.headers.get("location");
				if (!location) throw new Error("Grove OIDC login initiation omitted its redirect");
				const redirectHeaders = new Headers(initiated.headers);
				redirectHeaders.delete("content-type");
				return new Response(null, { status: 302, headers: redirectHeaders });
			}),
		readiness: authority.homeReadiness,
	};
};

const unavailableDuringBuild = () => Effect.die("Grove authentication is unavailable during build");

export const GroveAuthBuildLayer = Layer.succeed(GroveAuth, {
	isBrowserAuthRoute: unavailableDuringBuild,
	hydrateSession: unavailableDuringBuild,
	dispatch: unavailableDuringBuild,
	beginLogin: unavailableDuringBuild,
	readiness: unavailableDuringBuild(),
});
