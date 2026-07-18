import postgres from "postgres";
// Postgres connections (postgres-js). Three roles per the ordered migration (contract §3):
//   admin/owner  — migrations, seeding, the appender's INSERT path
//   console_app  — runtime scoped reads (non-BYPASSRLS); scopes set per-transaction via SET LOCAL
//   console_ro   — read-only SQL mode
// The scoped helpers set `app.scopes` as a LOCAL GUC so RLS filters to exactly the caller's grant.

import { asynchronously } from "#domain/iteration";

import type { Env } from "../env.ts";

export type Sql = postgres.Sql;

/**
 * postgres-js types a transaction handle (TransactionSql) as a sibling of Sql, not a subtype, so
 * a handle cannot be handed to scoped helpers that accept a pool `Sql` without widening. Do it
 * here, once, at a single typed boundary instead of an ad-hoc cast at each call site.
 */
export const txSql = (tx: postgres.TransactionSql): Sql => tx as unknown as Sql;

export interface Db {
	readonly admin: Sql;
	readonly app: Sql;
	readonly ro: Sql;
	/**
	 * The appender's connection (console_writer, non-superuser): inserts any scope, sees all for
	 * dedup.
	 */
	readonly writer: Sql;
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
	const writer =
		env.writerDatabaseUrl === env.databaseUrl
			? admin
			: postgres(env.writerDatabaseUrl, { max: 4, onnotice: () => {} });
	return {
		admin,
		app,
		ro,
		writer,
		async close() {
			const all = new Set([admin, app, ro, writer]);
			for await (const c of asynchronously(all)) await c.end({ timeout: 5 });
		},
	};
}

/**
 * Fail-closed guard against the RLS-bypass footgun (codex N1a P0): outside dev/test the caller
 * connection MUST be a distinct, non-superuser, non-BYPASSRLS role — otherwise every "scoped" read
 * silently runs as the superuser and RLS does nothing. Called at boot.
 */
export async function assertRuntimeRolesHardened(db: Db, devAuth: boolean): Promise<void> {
	if (devAuth) return;
	if (db.app === db.admin)
		throw new Error(
			"APP_DATABASE_URL must be a distinct non-superuser role in prod (RLS bypass otherwise)",
		);
	const rows = await db.app<
		{ rolsuper: boolean; rolbypassrls: boolean; who: string; is_writer: boolean }[]
	>`
		select rolsuper, rolbypassrls, current_user as who,
			pg_has_role(current_user, 'console_writer', 'MEMBER') as is_writer
		from pg_roles where rolname = current_user`;
	const r = rows[0];
	if (r.rolsuper || r.rolbypassrls)
		throw new Error("console app role must be NOSUPERUSER NOBYPASSRLS (RLS bypass otherwise)");
	// console_writer holds a `using(true)` policy on current_state/events (for the appender/projector);
	// the READ connection must NOT be that role, or scoped reads would see every row (codex N1b-1 P0).
	if (r.who === "console_writer" || r.is_writer)
		throw new Error(
			"APP_DATABASE_URL must connect as console_app, not console_writer (writer bypasses scope)",
		);
	if (db.ro === db.admin || db.ro === db.app)
		throw new Error("RO_DATABASE_URL must connect as the distinct console_ro role in prod");
	const roRows = await db.ro<
		{
			rolsuper: boolean;
			rolbypassrls: boolean;
			rolinherit: boolean;
			who: string;
			read_only: string;
			privileged_membership: boolean;
			write_privilege: boolean;
			create_privilege: boolean;
		}[]
	>`select rolsuper, rolbypassrls, current_user as who,
		rolinherit, current_setting('default_transaction_read_only') as read_only,
		exists (
			select 1 from pg_roles inherited
			where inherited.rolname <> current_user
			  and (inherited.rolsuper or inherited.rolbypassrls
			       or inherited.rolname in ('console_app', 'console_writer'))
			  and pg_has_role(current_user, inherited.oid, 'MEMBER')
		) as privileged_membership,
		exists (
			select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
			  and (has_table_privilege(current_user, c.oid, 'INSERT')
			    or has_table_privilege(current_user, c.oid, 'UPDATE')
			    or has_table_privilege(current_user, c.oid, 'DELETE')
			    or has_table_privilege(current_user, c.oid, 'TRUNCATE')
			    or has_table_privilege(current_user, c.oid, 'TRIGGER'))
		) as write_privilege,
		(has_schema_privilege(current_user, 'public', 'CREATE')
		 or has_database_privilege(current_user, current_database(), 'CREATE')) as create_privilege
	  from pg_roles where rolname = current_user`;
	const ro = roRows[0];
	if (
		ro.who !== "console_ro" ||
		ro.rolsuper ||
		ro.rolbypassrls ||
		ro.rolinherit ||
		ro.read_only !== "on" ||
		ro.privileged_membership ||
		ro.write_privilege ||
		ro.create_privilege
	)
		throw new Error(
			"console_ro must be NOINHERIT NOSUPERUSER NOBYPASSRLS, default read-only, and hold no effective write/create privilege",
		);
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
	// Defense-in-depth: a comma in a scope tag would split into a phantom scope in the GUC, which the
	// RLS policy splits on ','. Scopes are already SCOPE_RE-validated upstream (no comma possible);
	// this guard makes the invariant load-bearing at the boundary, not just asserted (sub-agent M4).
	if (scopes.some((s) => s.includes(","))) throw new Error("scope tag must not contain a comma");
	return sql.begin(async (tx) => {
		await tx`select set_config('app.scopes', ${scopes.join(",")}, true)`;
		return fn(txSql(tx));
	}) as Promise<T>;
}
