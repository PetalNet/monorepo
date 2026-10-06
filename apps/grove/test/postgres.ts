import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, ManagedRuntime, Redacted } from "effect";
import {
	applyMigrationFiles,
	ensureMigrationTable,
	readMigrationFilesEffect,
} from "effect-db/postgres/migrate";

const containers: StartedPostgreSqlContainer[] = [];

export const startGrovePostgres = async () => {
	const container = await new PostgreSqlContainer("postgres:17-alpine").start();
	containers.push(container);
	const databaseUrl = container.getConnectionUri();
	const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(databaseUrl) }));

	await runtime.runPromise(
		Effect.gen(function* () {
			const migrations = yield* readMigrationFilesEffect(
				fileURLToPath(new URL("../migrations", import.meta.url)),
			);
			const sql = yield* PgClient.PgClient;
			yield* sql.withTransaction(
				ensureMigrationTable("effect_qb_migrations").pipe(
					Effect.andThen(applyMigrationFiles("effect_qb_migrations", migrations)),
				),
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	return { databaseUrl, runtime };
};

export const stopGrovePostgres = async () => {
	await Promise.all(containers.splice(0).map((container) => container.stop()));
};
