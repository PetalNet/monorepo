import { readFile } from "node:fs/promises";

import * as PgClient from "@effect/sql-pg/PgClient";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, ManagedRuntime, Redacted } from "effect";

const containers: StartedPostgreSqlContainer[] = [];

export const startGrovePostgres = async () => {
	const container = await new PostgreSqlContainer("postgres:17-alpine").start();
	containers.push(container);
	const databaseUrl = container.getConnectionUri();
	const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(databaseUrl) }));

	for (const name of ["0001_initial.sql", "0002_auth.sql", "0003_actor_auth.sql"]) {
		const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
		const up = migration.split("-- effect-db:down", 1)[0]?.replace("-- effect-db:up", "");
		if (!up) throw new Error(`Migration ${name} has no up section`);
		await runtime.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe<Record<string, never>>(up).raw),
		);
	}

	return { databaseUrl, runtime };
};

export const stopGrovePostgres = async () => {
	await Promise.all(containers.splice(0).map((container) => container.stop()));
};
