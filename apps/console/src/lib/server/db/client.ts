import { PgClient } from "@effect/sql-pg";
import { Redacted } from "effect";
import { Executor } from "effect-qb/postgres";

export const makeDatabaseLayer = (databaseUrl: string) =>
	PgClient.layer({
		url: Redacted.make(databaseUrl),
		applicationName: "lab-console",
		maxConnections: 10,
	});

export const postgresExecutor = Executor.make();
