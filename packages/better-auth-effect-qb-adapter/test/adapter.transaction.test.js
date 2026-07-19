import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEffectQbAdapter } from "../src/index.js";
import { startPostgres, stopPostgres } from "./postgres.js";
describe("effect-qb Postgres transaction", async () => {
	const databaseUrl = await startPostgres();
	const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(databaseUrl) }));
	const factory = createEffectQbAdapter(databaseUrl);
	const adapter = factory({});
	beforeAll(async () => {
		await runtime.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) =>
				sql.unsafe(
					'create table "user" ("id" text primary key, "name" text not null, "email" text not null, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz not null, "updatedAt" timestamptz not null)',
				),
			),
		);
	});
	afterAll(async () => {
		await factory.close();
		await runtime.dispose();
		await stopPostgres();
	});
	it("rolls back a failing callback", async () => {
		await expect(
			adapter.transaction(async (transaction) => {
				await transaction.create({
					model: "user",
					data: {
						id: "transaction-user",
						name: "Transaction User",
						email: "transaction@example.com",
						emailVerified: true,
						image: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
					forceAllowId: true,
				});
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(await adapter.count({ model: "user" })).toBe(0);
	});
});
