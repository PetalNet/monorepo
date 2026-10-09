import * as PgClient from "@effect/sql-pg/PgClient";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { ManagedRuntime } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startGrovePostgres, stopGrovePostgres } from "../../../../test/postgres";
import { makeAuthDatabase } from "./client";
import { authTables } from "./tables";

let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>;

beforeAll(async () => {
	runtime = (await startGrovePostgres()).runtime;
}, 60_000);

afterAll(async () => {
	await runtime.dispose();
	await stopGrovePostgres();
});

it("isolates concurrent auth transactions, rolls back rejection, and reports affected rows", async () => {
	const pg = await runtime.runPromise(PgClient.PgClient);
	const adapter = drizzleAdapter(makeAuthDatabase(pg, runtime), {
		provider: "pg",
		transaction: true,
		schema: authTables,
	})({});
	const user = (id: string) => ({ id, name: id, email: `${id}@example.com`, emailVerified: true });
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
