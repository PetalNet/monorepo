import { createServer, type Server } from "node:http";

import * as PgClient from "@effect/sql-pg/PgClient";
import type { RequestEvent } from "@sveltejs/kit";
import { makeSignature } from "better-auth/crypto";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startGrovePostgres, stopGrovePostgres } from "../../../test/postgres";
import { GroveBetterAuthLayer } from "./auth";
import { BetterAuth } from "./better-auth";

let parent: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>;
let provider: Server;
let issuer: string;

beforeAll(async () => {
	parent = (await startGrovePostgres()).runtime;

	provider = createServer((request, response) => {
		if (request.url !== "/.well-known/openid-configuration") {
			response.writeHead(404).end();

			return;
		}

		response.setHeader("content-type", "application/json");

		response.end(
			JSON.stringify({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				id_token_signing_alg_values_supported: ["RS256"],
			}),
		);
	});

	await new Promise<void>((resolve) => {
		provider.listen(0, "127.0.0.1", resolve);
	});

	const address = provider.address();

	if (!address || typeof address === "string") {
		throw new Error("Expected an OIDC fixture port");
	}

	issuer = `http://127.0.0.1:${String(address.port)}`;
}, 60_000);

afterAll(async () => {
	await parent.dispose();
	await stopGrovePostgres();

	await new Promise<void>((resolve, reject) => {
		provider.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
});

it("cancels a real auth query on scope disposal without closing the borrowed pool", async () => {
	const pg = await parent.runPromise(PgClient.PgClient);
	const secret = "lifecycle-test-secret-at-least-32-characters";
	const token = "lifecycle-session-token";
	const headers = new Headers({
		cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, secret)}`)}`,
	});
	const request = new Request("https://grove.example/api/auth/get-session", { headers });
	const event = {
		request,
		url: new URL(request.url),
		locals: { actor: null, session: null, user: null },
		cookies: { set: () => undefined },
	} as unknown as RequestEvent;
	const authRuntime = ManagedRuntime.make(
		GroveBetterAuthLayer(
			{
				baseUrl: "https://grove.example",
				secret,
				issuer,
				clientId: "grove",
				clientSecret: "fixture-client-secret",
			},
			() => event,
		).pipe(Layer.provide(Layer.succeedContext(await parent.context()))),
	);
	const locked = Promise.withResolvers<undefined>();
	const release = Promise.withResolvers<undefined>();

	try {
		await parent.runPromise(pg`insert into "user" (id, name, email, "emailVerified")
			values ('lifecycle-user', 'Lifecycle', 'lifecycle@example.com', true)`);

		await parent.runPromise(pg`insert into "session" (id, "userId", token, "expiresAt")
			values ('lifecycle-session', 'lifecycle-user', ${token}, '2099-01-01T00:00:00Z')`);

		const auth = await authRuntime.runPromise(BetterAuth);

		expect(await Effect.runPromise(auth.getSession(headers))).toMatchObject({
			user: { id: "lifecycle-user" },
		});

		const blocker = parent.runPromise(
			pg.withTransaction(
				Effect.gen(function* () {
					yield* pg.unsafe('lock table "session" in access exclusive mode');
					locked.resolve(undefined);
					yield* Effect.promise(() => release.promise);
				}),
			),
		);

		try {
			await locked.promise;
			const pending = Effect.runPromiseExit(auth.getSession(headers));
			const waiting = pg`select pid from pg_stat_activity
				where datname = current_database() and wait_event_type = 'Lock'
				and query like '%"session"%' and query not like '%pg_stat_activity%'`;

			await parent.runPromise(
				Effect.gen(function* () {
					for (let attempt = 0; attempt < 200; attempt++) {
						if ((yield* waiting).length > 0) {
							return;
						}

						yield* Effect.sleep("10 millis");
					}

					return yield* Effect.die("Expected a blocked Better Auth session query");
				}),
			);

			await authRuntime.dispose();

			expect(Exit.isFailure(await pending)).toBe(true);
			expect(await parent.runPromise(waiting)).toEqual([]);
			expect(await parent.runPromise(pg`select 1 as alive`)).toEqual([{ alive: 1 }]);
		} finally {
			release.resolve(undefined);
			await blocker;
		}
	} finally {
		await authRuntime.dispose();
	}
});
