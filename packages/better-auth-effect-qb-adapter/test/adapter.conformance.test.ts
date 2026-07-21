import {
	caseInsensitiveTestSuite,
	normalTestSuite,
	testAdapter,
} from "@better-auth/test-utils/adapter";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { Effect, ManagedRuntime, Redacted } from "effect";
import { describe } from "vitest";

import { createEffectQbAdapter } from "../src/index.js";
import { startPostgres, stopPostgres } from "./postgres.js";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sqlType = (type: unknown) => {
	if (type === "boolean") return "boolean";
	if (type === "number") return "double precision";
	if (type === "date") return "timestamptz";
	if (type === "json" || (typeof type === "string" && type.endsWith("[]")) || Array.isArray(type))
		return "jsonb";
	return "text";
};

describe("effect-qb Postgres adapter conformance", async () => {
	const databaseUrl = await startPostgres();
	const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(databaseUrl) }));
	const factory = createEffectQbAdapter(databaseUrl);
	const runMigrations = async (options: BetterAuthOptions) => {
		const tables = getAuthTables(options);
		const statements = Object.values(tables)
			.toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0))
			.map((table) => {
				const columns = [`"id" text primary key`];
				for (const [field, attributes] of Object.entries(table.fields)) {
					const clauses = [quote(attributes.fieldName ?? field), sqlType(attributes.type)];
					if (attributes.required) clauses.push("not null");
					if (attributes.unique) clauses.push("unique");
					columns.push(clauses.join(" "));
				}
				return `create table ${quote(table.modelName)} (${columns.join(", ")})`;
			});
		await runtime.runPromise(
			Effect.flatMap(PgClient.PgClient, (sql) =>
				Effect.gen(function* () {
					yield* sql.unsafe("drop schema public cascade; create schema public");
					for (const statement of statements) yield* sql.unsafe(statement);
				}),
			),
		);
	};
	const suite = await testAdapter({
		adapter: () => factory,
		runMigrations,
		tests: [normalTestSuite(), caseInsensitiveTestSuite()],
		onFinish: async () => {
			await factory.close();
			await runtime.dispose();
			await stopPostgres();
		},
	});
	suite.execute();
});
