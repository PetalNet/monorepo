import { PgClient } from "@effect/sql-pg";
import { Redacted } from "effect";

export const makeDatabaseLayer = (databaseUrl: string) =>
	PgClient.layer({
		url: Redacted.make(databaseUrl),
		applicationName: "lab-console",
		maxConnections: 10,
	});
