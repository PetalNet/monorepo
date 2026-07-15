import { getAuthTables } from "better-auth/db";
import type { BetterAuthOptions } from "better-auth";
import {
	caseInsensitiveTestSuite,
	normalTestSuite,
	testAdapter,
} from "@better-auth/test-utils/adapter";
import { Pool } from "pg";
import { describe } from "vitest";
import { createEffectQbAdapter } from "./adapter";

const databaseUrl = process.env.ADAPTER_TEST_DATABASE_URL;
const enabled = databaseUrl ? describe : describe.skip;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sqlType = (type: unknown) => {
	if (type === "boolean") return "boolean";
	if (type === "number") return "double precision";
	if (type === "date") return "timestamptz";
	if (type === "json" || (typeof type === "string" && type.endsWith("[]")) || Array.isArray(type)) return "jsonb";
	return "text";
};

enabled("effect-qb Postgres adapter conformance", async () => {
	const pool = new Pool({ connectionString: databaseUrl });
	const adapter = createEffectQbAdapter(databaseUrl!);
	const runMigrations = async (options: BetterAuthOptions) => {
		const tables = getAuthTables(options);
		const client = await pool.connect();
		try {
			await client.query("drop schema public cascade; create schema public");
			const statements = Object.values(tables).toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0)).map((table) => {
				const columns = [`"id" text primary key`];
				for (const [field, attributes] of Object.entries(table.fields)) {
					const name = attributes.fieldName ?? field;
					const clauses = [quote(name), sqlType(attributes.type)];
					if (attributes.required) clauses.push("not null");
					if (attributes.unique) clauses.push("unique");
					columns.push(clauses.join(" "));
				}
				return `create table ${quote(table.modelName)} (${columns.join(", ")})`;
			});
			await statements.reduce(
				(previous, statement) => previous.then(() => client.query(statement).then(() => undefined)),
				Promise.resolve(),
			);
		} finally {
			client.release();
		}
	};
	const suite = await testAdapter({
		adapter: () => adapter,
		runMigrations,
		tests: [normalTestSuite(), caseInsensitiveTestSuite()],
		onFinish: async () => {
			await adapter.close();
			await pool.end();
		},
	});
	suite.execute();
});
