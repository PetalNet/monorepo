import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEffectQbAdapter } from "./adapter";

const databaseUrl = process.env.ADAPTER_TEST_DATABASE_URL;
const enabled = databaseUrl ? describe : describe.skip;

enabled("effect-qb Postgres transaction", () => {
	const pool = new Pool({ connectionString: databaseUrl });
	const factory = createEffectQbAdapter(databaseUrl!);
	const adapter = factory({});

	beforeAll(async () => {
		await pool.query("drop schema public cascade; create schema public");
		await pool.query('create table "user" ("id" text primary key, "name" text not null, "email" text not null, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz not null, "updatedAt" timestamptz not null)');
	});

	afterAll(async () => {
		await factory.close();
		await pool.end();
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
