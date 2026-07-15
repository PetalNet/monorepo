import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migration = await readFile(
	fileURLToPath(new URL("../../../../migrations/001-foundation.sql", import.meta.url)),
	"utf8",
);
await Effect.runPromise(
	Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe(migration)).pipe(
		Effect.provide(PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 1 })),
	),
);
