// Postgres connections (postgres-js). Three roles per the ordered migration (contract §3):
//   admin/owner  — migrations, seeding, the appender's INSERT path
//   console_app  — runtime scoped reads (non-BYPASSRLS); scopes set per-transaction via SET LOCAL
//   console_ro   — read-only SQL mode
// The scoped helpers set `app.scopes` as a LOCAL GUC so RLS filters to exactly the caller's grant.

import postgres from "postgres";

import type { Env } from "../env.ts";

export type Sql = postgres.Sql;

export interface Db {
	readonly admin: Sql;
	readonly app: Sql;
	readonly ro: Sql;
	close(): Promise<void>;
}

export function openDb(env: Env): Db {
	const admin = postgres(env.databaseUrl, { max: 8, onnotice: () => {} });
	const app =
		env.appDatabaseUrl === env.databaseUrl
			? admin
			: postgres(env.appDatabaseUrl, { max: 8, onnotice: () => {} });
	const ro =
		env.roDatabaseUrl === env.appDatabaseUrl
			? app
			: postgres(env.roDatabaseUrl, { max: 4, onnotice: () => {} });
	return {
		admin,
		app,
		ro,
		async close() {
			await admin.end({ timeout: 5 });
			if (app !== admin) await app.end({ timeout: 5 });
			if (ro !== app && ro !== admin) await ro.end({ timeout: 5 });
		},
	};
}

/**
 * Run `fn` inside a transaction with `app.scopes` set to the caller's readable scopes, so every
 * SELECT is RLS-filtered to exactly that grant set. Empty scopes => no rows (fail-closed). SET
 * LOCAL is transaction-scoped, so it cannot leak into a pooled connection's next use.
 */
export async function withScopes<T>(
	sql: Sql,
	scopes: readonly string[],
	fn: (tx: Sql) => Promise<T>,
): Promise<T> {
	return sql.begin(async (tx) => {
		// scope tags are validated (SCOPE_RE) before reaching here; still pass as a bound value.
		await tx`select set_config('app.scopes', ${scopes.join(",")}, true)`;
		return fn(tx as Sql);
	}) as Promise<T>;
}
