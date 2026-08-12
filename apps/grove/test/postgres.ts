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

	const names = [
		"0001_initial.sql",
		"0002_auth.sql",
		"0003_actor_auth.sql",
		"0004_clear_oidc_id_tokens.sql",
	] as const;
	const migrations = await Promise.all(
		names.map(async (name) => ({
			name,
			migration: await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
		})),
	);
	await runtime.runPromise(
		Effect.forEach(
			migrations,
			({ name, migration }) => {
				const up = migration.split("-- effect-db:down", 1)[0]?.replace("-- effect-db:up", "");
				if (!up) return Effect.die(new Error(`Migration ${name} has no up section`));
				return Effect.flatMap(
					PgClient.PgClient,
					(sql) => sql.unsafe<Record<string, never>>(up).raw,
				);
			},
			{ concurrency: 1, discard: true },
		),
	);

	return { databaseUrl, runtime };
};

export const stopGrovePostgres = async () => {
	await Promise.all(containers.splice(0).map((container) => container.stop()));
};
