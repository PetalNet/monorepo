import * as PgClient from "@effect/sql-pg/PgClient";
import { eq } from "drizzle-orm";
import { Effect, type ManagedRuntime } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startGrovePostgres, stopGrovePostgres } from "../../../../test/postgres";
import { makeAuthDatabase, makeDatabase } from "./client";
import { accounts, grove_objects as objects, users } from "./tables";

let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>;

beforeAll(async () => {
	runtime = (await startGrovePostgres()).runtime;
}, 60_000);

afterAll(async () => {
	await runtime.dispose();
	await stopGrovePostgres();
});

it("round-trips domain timestamps and nullable auth Dates through the live clients", async () => {
	const pg = await runtime.runPromise(PgClient.PgClient);
	const db = await runtime.runPromise(makeDatabase(pg));
	const user = (id: string) => ({ id, name: id, email: `${id}@example.com`, emailVerified: true });
	const id = "domain-codec";
	const date = new Date("2026-10-09T12:34:56.789Z");

	await runtime.runPromise(
		pg.withTransaction(
			Effect.gen(function* () {
				yield* db.insert(objects).values({
					id,
					kind: "artifact",
					scope: "private",
					created_at: date.toISOString(),
				});

				const rows = yield* db.select().from(objects).where(eq(objects.id, id));

				expect(rows).toMatchObject([{ id, kind: "artifact", scope: "private" }]);
				expect(typeof rows[0]?.created_at).toBe("string");
				expect(new Date(rows[0]?.created_at ?? "")).toEqual(date);

				yield* db.insert(users).values({ ...user("native-codec"), createdAt: date });

				expect(
					yield* db
						.select({ date: users.createdAt })
						.from(users)
						.where(eq(users.id, "native-codec")),
				).toEqual([{ date }]);

				yield* db.delete(users).where(eq(users.id, "native-codec"));
				yield* db.delete(objects).where(eq(objects.id, id));
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
