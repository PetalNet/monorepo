import { getRequestEvent } from "$app/server";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { RequestEvent } from "@sveltejs/kit";
import type { ResolveOptions } from "@sveltejs/kit/hooks";
import type { Session, User } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";

import { ActorAuthority, type AuthorityError, type PersonPrincipal } from "./actors/authority";
import { BetterAuth, type BetterAuthApiError, BetterAuthLayer } from "./better-auth";
import { makeAuthDatabase, makeDatabase } from "./db/client";
import { accounts as accountsTable, authTables } from "./db/tables";
import { GROVE_OIDC_PROVIDER_ID, groveOidc } from "./oidc";

export interface GroveBrowserAuthConfig {
	readonly baseUrl: string;
	readonly secret: string;
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
}

export const GroveBetterAuthLayer = (
	config: GroveBrowserAuthConfig,
	requestEvent: () => RequestEvent = getRequestEvent,
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient;
			const runtime = yield* Effect.acquireRelease(
				Effect.sync(() => ManagedRuntime.make(Layer.succeed(PgClient.PgClient, sql))),
				(managed) => managed.disposeEffect,
			);

			return BetterAuthLayer({
				appName: "Grove",
				baseURL: config.baseUrl,
				secret: config.secret,
				database: drizzleAdapter(makeAuthDatabase(sql, runtime), {
					provider: "pg",
					transaction: true,
					schema: authTables,
				}),
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
						issuer: config.issuer.replace(/\/+$/, ""),
						clientId: config.clientId,
						clientSecret: config.clientSecret,
						callbackOrigin: config.baseUrl,
					}),
					sveltekitCookies(requestEvent),
				],
			});
		}),
	);

export class BrowserAuthDatabaseError extends Data.TaggedError("BrowserAuthDatabaseError")<{
	readonly cause: unknown;
}> {
	override get message() {
		return "The browser authentication database is unavailable";
	}
}

export type BrowserSessionError = BetterAuthApiError | BrowserAuthDatabaseError | AuthorityError;

export interface BrowserSession {
	readonly session: Session;
	readonly user: User;
	readonly actor: PersonPrincipal;
}

export interface BrowserSessionInspection {
	readonly session: Session;
	readonly user: User;
	readonly actor: PersonPrincipal | null;
}

interface GroveAuthShape {
	readonly isBrowserAuthRoute: (url: string) => Effect.Effect<boolean>;
	readonly inspectSession: (
		headers: Headers,
	) => Effect.Effect<BrowserSessionInspection | null, BrowserSessionError>;
	readonly hydrateSession: (
		headers: Headers,
	) => Effect.Effect<BrowserSession | null, BrowserSessionError>;
	readonly dispatch: (input: {
		readonly event: RequestEvent;
		readonly resolve: (
			event: RequestEvent,
			options?: ResolveOptions,
		) => Response | Promise<Response>;
	}) => Effect.Effect<Response>;
	readonly beginLogin: (
		headers: Headers,
		callbackURL?: string,
	) => Effect.Effect<Response, BetterAuthApiError>;
	readonly endSession: (
		headers: Headers,
		returnTo: string,
	) => Effect.Effect<Response, BetterAuthApiError>;
	readonly readiness: ActorAuthority["Service"]["homeReadiness"];
}

export class GroveAuth extends Context.Service<GroveAuth, GroveAuthShape>()("grove/GroveAuth") {}

const isBrowserAuthPath = (url: string) => new URL(url).pathname.startsWith("/api/auth/");

export const GroveAuthLayer = (configuredIssuer: string) =>
	Layer.effect(
		GroveAuth,
		Effect.gen(function* () {
			const issuer = configuredIssuer.replace(/\/+$/, "");
			const auth = yield* BetterAuth;
			const sql = yield* PgClient.PgClient;
			const authority = yield* ActorAuthority;
			const db = yield* makeDatabase(sql);
			const validatedSession = (headers: Headers) =>
				Effect.gen(function* () {
					const current = yield* auth.getSession(headers);

					if (!current?.user.emailVerified) {
						return null;
					}

					// This provider is bound to the discovery-verified configured issuer at startup.
					const accounts = yield* db
						.select({ subject: accountsTable.accountId })
						.from(accountsTable)
						.where(
							and(
								eq(accountsTable.userId, current.user.id),
								eq(accountsTable.providerId, GROVE_OIDC_PROVIDER_ID),
							),
						)
						.pipe(Effect.mapError((cause) => new BrowserAuthDatabaseError({ cause })));
					const account = accounts.at(0);

					if (!account || accounts.length !== 1) {
						return null;
					}

					return {
						current,
						identity: {
							authUserId: current.user.id,
							issuer,
							subject: account.subject,
						},
					};
				});

			return GroveAuth.of({
				isBrowserAuthRoute: (url) => Effect.sync(() => isBrowserAuthPath(url)),
				inspectSession: (headers) =>
					Effect.gen(function* () {
						const validated = yield* validatedSession(headers);

						if (!validated) {
							return null;
						}

						const actor = yield* authority.lookupBrowserIdentity(validated.identity);

						return { ...validated.current, actor };
					}),
				hydrateSession: (headers) =>
					Effect.gen(function* () {
						const validated = yield* validatedSession(headers);

						if (!validated) {
							return null;
						}

						const actor = yield* authority.bindBrowserIdentity({
							...validated.identity,
							name: validated.current.user.name,
							emailVerified: validated.current.user.emailVerified,
						});

						return { ...validated.current, actor };
					}),
				dispatch: ({ event, resolve }) => {
					if (
						event.request.method === "POST" &&
						event.url.pathname === "/api/auth/sign-in/social"
					) {
						return Effect.succeed(new Response("Not found", { status: 404 }));
					}

					if (isBrowserAuthPath(event.url.toString())) {
						return auth.handler(event.request);
					}

					return Effect.promise(() => Promise.resolve(resolve(event)));
				},
				beginLogin: (headers, callbackURL = "/") =>
					Effect.gen(function* () {
						const initiated = yield* auth.signInSocial(headers, {
							provider: GROVE_OIDC_PROVIDER_ID,
							callbackURL,
						});
						const location = initiated.get("location");

						if (!location) {
							throw new Error("Grove OIDC login initiation omitted its redirect");
						}

						const redirectHeaders = new Headers(initiated);

						redirectHeaders.delete("content-type");

						return new Response(null, { status: 302, headers: redirectHeaders });
					}),
				endSession: (headers, returnTo) =>
					Effect.gen(function* () {
						const signedOut = yield* auth.signOut(headers);
						const redirectHeaders = new Headers(signedOut);

						redirectHeaders.delete("content-type");
						redirectHeaders.set("location", returnTo);

						return new Response(null, { status: 302, headers: redirectHeaders });
					}),
				readiness: authority.homeReadiness,
			});
		}),
	);

const unavailableDuringBuild = () => Effect.die("Grove authentication is unavailable during build");

export const GroveAuthBuildLayer = Layer.succeed(GroveAuth, {
	isBrowserAuthRoute: unavailableDuringBuild,
	inspectSession: unavailableDuringBuild,
	hydrateSession: unavailableDuringBuild,
	dispatch: unavailableDuringBuild,
	beginLogin: unavailableDuringBuild,
	endSession: unavailableDuringBuild,
	readiness: unavailableDuringBuild(),
});
