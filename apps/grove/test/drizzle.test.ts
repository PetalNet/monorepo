import * as PgClient from "@effect/sql-pg/PgClient";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq, sql as querySql } from "drizzle-orm";
import { Effect, Exit, type ManagedRuntime } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";

import { makeAuthDatabase, makeDatabase } from "../src/lib/server/db/client";
import { accounts, authTables, sprouts, users } from "../src/lib/server/db/tables";
import { startGrovePostgres, stopGrovePostgres } from "./postgres";

let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>;

beforeAll(async () => {
	runtime = (await startGrovePostgres()).runtime;
}, 60_000);

afterAll(async () => {
	await runtime.dispose();
	await stopGrovePostgres();
});

const user = (id: string) => ({ id, name: id, email: `${id}@example.com`, emailVerified: true });

it("joins the caller's transaction with raw SQL and preserves SQL failure reasons", async () => {
	await runtime.runPromise(
		Effect.gen(function* () {
			const pg = yield* PgClient.PgClient;
			const db = yield* makeDatabase(pg);
			const failure = yield* Effect.flip(
				pg.withTransaction(
					Effect.gen(function* () {
						yield* db.insert(users).values(user("drizzle-rollback")).execute();
						yield* pg`insert into "user" (id, name, email, "emailVerified") values ('raw-rollback', 'Raw', 'raw@example.com', true)`;
						yield* db.insert(users).values(user("drizzle-rollback")).execute();
					}),
				),
			);

			expect(failure).toMatchObject({
				_tag: "EffectDrizzleQueryError",
				cause: {
					reasons: [{ error: { reason: { _tag: "UniqueViolation", constraint: "user_pkey" } } }],
				},
			});

			expect(yield* db.select({ id: users.id }).from(users).execute()).toEqual([]);
		}),
	);
});

it("isolates concurrent auth transactions, rolls back rejection, and reports affected rows", async () => {
	const pg = await runtime.runPromise(PgClient.PgClient);
	const adapter = drizzleAdapter(makeAuthDatabase(pg, runtime), {
		provider: "pg",
		transaction: true,
		schema: authTables,
	})({});
	const written = Promise.withResolvers<undefined>();
	const committed = Promise.withResolvers<undefined>();
	const failure = new Error("reject auth transaction");
	const rejected = adapter.transaction(async (tx) => {
		await tx.create({ model: "user", data: user("auth-rollback"), forceAllowId: true });
		written.resolve(undefined);
		await committed.promise;

		throw failure;
	});
	const rejection = expect(rejected).rejects.toBe(failure);

	await written.promise;

	try {
		await adapter.transaction(async (tx) => {
			await tx.create({ model: "user", data: user("auth-commit"), forceAllowId: true });
		});
	} finally {
		committed.resolve(undefined);
	}

	await rejection;
	expect(await adapter.findMany({ model: "user" })).toMatchObject([{ id: "auth-commit" }]);

	expect(
		await adapter.deleteMany({ model: "user", where: [{ field: "id", value: "auth-commit" }] }),
	).toBe(1);

	expect(await adapter.count({ model: "user" })).toBe(0);
});

it("interrupts a live query and rolls back before reusing the pool", async () => {
	const pg = await runtime.runPromise(PgClient.PgClient);
	const db = await runtime.runPromise(makeDatabase(pg));
	const abort = new AbortController();
	const pending = runtime.runPromiseExit(
		pg.withTransaction(
			Effect.gen(function* () {
				yield* db.insert(users).values(user("interrupted")).execute();
				yield* db.execute(querySql`select pg_sleep(30) /* grove-drizzle-cancel */`);

				yield* db
					.update(users)
					.set({ name: "late write" })
					.where(eq(users.id, "interrupted"))
					.execute();
			}),
		),
		{ signal: abort.signal },
	);

	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				for (let attempt = 0; attempt < 200; attempt++) {
					const rows =
						yield* pg`select pid from pg_stat_activity where wait_event='PgSleep' and query like '%grove-drizzle-cancel%'`;

					if (rows.length > 0) {
						return;
					}

					yield* Effect.sleep("10 millis");
				}

				return yield* Effect.die("Expected a live cancellation query");
			}),
		);
	} finally {
		abort.abort();
	}

	expect(Exit.hasInterrupts(await pending)).toBe(true);

	expect(
		await runtime.runPromise(db.select().from(users).where(eq(users.id, "interrupted")).execute()),
	).toEqual([]);

	expect(
		await runtime.runPromise(
			pg`select pid from pg_stat_activity where wait_event='PgSleep' and query like '%grove-drizzle-cancel%'`,
		),
	).toEqual([]);
});

it("round-trips lossless domain identities and nullable auth Dates through the live clients", async () => {
	const pg = await runtime.runPromise(PgClient.PgClient);
	const db = await runtime.runPromise(makeDatabase(pg));
	const id = "9223372036854775807";
	const date = new Date("2026-10-09T12:34:56.789Z");

	await runtime.runPromise(
		pg.withTransaction(
			Effect.gen(function* () {
				yield* pg`insert into grove_demo_sprouts (id, name, planted_at) overriding system value
					values (${id}, 'Codec fern', ${date.toISOString()})`;

				const rows = yield* db.select().from(sprouts).where(eq(sprouts.id, id)).execute();

				expect(rows).toMatchObject([{ id, name: "Codec fern", waterings: 0 }]);
				expect(typeof rows[0]?.planted_at).toBe("string");
				expect(new Date(rows[0]?.planted_at ?? "")).toEqual(date);
				expect(JSON.stringify(rows)).toContain('"id":"9223372036854775807"');

				yield* db
					.insert(users)
					.values({ ...user("native-codec"), createdAt: date })
					.execute();

				expect(
					yield* db
						.select({ date: users.createdAt })
						.from(users)
						.where(eq(users.id, "native-codec"))
						.execute(),
				).toEqual([{ date }]);

				yield* db.delete(users).where(eq(users.id, "native-codec")).execute();
				yield* db.delete(sprouts).where(eq(sprouts.id, id)).execute();
			}),
		),
	);

	await makeAuthDatabase(pg, runtime).transaction(async (tx) => {
		await tx.insert(users).values({ ...user("auth-codec"), createdAt: date });

		await tx.insert(accounts).values({
			id: "auth-codec-account",
			userId: "auth-codec",
			accountId: "codec-subject",
			providerId: "grove-oidc",
			accessTokenExpiresAt: date,
			refreshTokenExpiresAt: null,
		});

		expect(
			await tx.select({ date: users.createdAt }).from(users).where(eq(users.id, "auth-codec")),
		).toEqual([{ date }]);

		expect(
			await tx
				.select({ access: accounts.accessTokenExpiresAt, refresh: accounts.refreshTokenExpiresAt })
				.from(accounts)
				.where(eq(accounts.id, "auth-codec-account")),
		).toEqual([{ access: date, refresh: null }]);

		await tx.delete(users).where(eq(users.id, "auth-codec"));
	});
});
