// Postgres connections, driven by @effect/sql-pg (the sole pg layer). Three roles per the ordered
// migration (contract §3):
//   admin/owner  — migrations, seeding, the appender's INSERT path
//   console_app  — runtime scoped reads (non-BYPASSRLS); scopes set per-transaction via SET LOCAL
//   console_ro   — read-only SQL mode
// The scoped helpers set `app.scopes` as a LOCAL GUC so RLS filters to exactly the caller's grant.
//
// The domain speaks promises; this module exposes a tagged-template `Sql` facade over PgClient.
// Transactions reserve a dedicated connection and route every statement through the client's
// transaction service, so a transaction handle IS an `Sql` — no `as unknown as Sql` cast anywhere.
import { PgClient } from "@effect/sql-pg";
import { Duration, Effect, Exit, Fiber, Redacted, Scope, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import type { Connection } from "effect/unstable/sql/SqlConnection";

import { asynchronously } from "#domain/iteration";

import type { Env } from "../env.ts";

export type Row = Record<string, unknown>;

export interface ListenHandle {
	unlisten(): Promise<void>;
}

export interface Sql {
	<T = Row[]>(strings: TemplateStringsArray, ...params: readonly unknown[]): Promise<T>;
	/** Value-list fragment for `in ${sql([...])}` sites. */
	(values: readonly unknown[]): unknown;
	/** Run `fn` on one reserved connection inside BEGIN/COMMIT; the handle is a full `Sql`. */
	begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
	/** JSON parameter fragment (jsonb-safe). */
	json(value: unknown): unknown;
	/** Array parameter for `= any(...)` sites. */
	array(values: readonly unknown[]): unknown;
	unsafe<T = Row[]>(text: string, params?: readonly unknown[]): Promise<T>;
	listen(channel: string, onPayload: (payload: string) => void): Promise<ListenHandle>;
	end(opts?: { timeout?: number }): Promise<void>;
}

interface ClientHandle {
	readonly client: PgClient.PgClient;
	readonly close: () => Promise<void>;
}

async function openClient(
	url: string,
	maxConnections: number,
	connectTimeoutSeconds?: number,
): Promise<ClientHandle> {
	const scope = await Effect.runPromise(Scope.make());
	const client = await Effect.runPromise(
		PgClient.make({
			url: Redacted.make(url),
			maxConnections,
			...(connectTimeoutSeconds === undefined
				? {}
				: { connectTimeout: Duration.seconds(connectTimeoutSeconds) }),
		}).pipe(Scope.provide(scope), Effect.provide(Reactivity.layer)),
	);
	return {
		client,
		close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
	};
}

/** Rejections surface the driver's error (message, code) rather than the SqlError wrapper. */
const unwrapDriverError = (error: unknown): unknown => {
	if (!(error instanceof Error) || (error as { _tag?: unknown })._tag !== "SqlError") return error;
	let current: Error = error;
	while (current.cause instanceof Error) current = current.cause;
	return current;
};

const run = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
	Effect.runPromise(effect as Effect.Effect<A>).catch((error: unknown) => {
		throw unwrapDriverError(error);
	});

function makeSql(handle: ClientHandle, txConnection: Connection | null): Sql {
	const { client } = handle;
	const inTx = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
		txConnection
			? Effect.provideService(effect, client.transactionService, [txConnection, 0])
			: effect;
	const facade = ((strings: TemplateStringsArray | readonly unknown[], ...params: never[]) =>
		Array.isArray(strings) && !("raw" in strings)
			? // Called with a plain array: an `in ${sql([...])}` value-list fragment.
				client.in(strings as never[])
			: run(inTx(client<never>(strings as TemplateStringsArray, ...params)))) as Sql;
	// Pre-stringified: pg would serialize a JS array param as a PG array literal, not JSON.
	facade.json = (value) => client.json(JSON.stringify(value));
	facade.array = (values) => [...values];
	facade.unsafe = <T>(text: string, params: readonly unknown[] = []) =>
		run(inTx(client.unsafe(text, params))) as Promise<T>;
	facade.begin = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
		if (txConnection) throw new Error("nested transactions are not supported");
		const scope = await Effect.runPromise(Scope.make());
		try {
			const connection = await Effect.runPromise(Scope.provide(client.reserve, scope));
			const tx = makeSql(handle, connection);
			await run(connection.executeUnprepared("begin", [], undefined));
			try {
				const result = await fn(tx);
				await run(connection.executeUnprepared("commit", [], undefined));
				return result;
			} catch (error) {
				await run(connection.executeUnprepared("rollback", [], undefined)).catch(() => undefined);
				throw error;
			}
		} finally {
			await Effect.runPromise(Scope.close(scope, Exit.void));
		}
	};
	facade.listen = (channel, onPayload) => {
		const fiber = Effect.runFork(
			Stream.runForEach(client.listen(channel), (payload) =>
				Effect.sync(() => {
					onPayload(payload);
				}),
			),
		);
		return Promise.resolve({
			unlisten: async () => {
				await Effect.runPromise(Fiber.interrupt(fiber));
			},
		});
	};
	facade.end = () => handle.close();
	return facade;
}

/** A standalone facade client outside the role'd `Db` (session verifier, scripts, tests). */
export async function openSql(
	url: string,
	maxConnections = 4,
	opts: { connectTimeoutSeconds?: number } = {},
): Promise<Sql> {
	return makeSql(await openClient(url, maxConnections, opts.connectTimeoutSeconds), null);
}

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

export async function openDb(env: Env): Promise<Db> {
	const admin = await openClient(env.databaseUrl, 8);
	const app =
		env.appDatabaseUrl === env.databaseUrl ? admin : await openClient(env.appDatabaseUrl, 8);
	const ro =
		env.roDatabaseUrl === env.appDatabaseUrl ? app : await openClient(env.roDatabaseUrl, 4);
	const writer =
		env.writerDatabaseUrl === env.databaseUrl ? admin : await openClient(env.writerDatabaseUrl, 4);
	const handles = new Set([admin, app, ro, writer]);
	const sqls = new Map<ClientHandle, Sql>();
	for (const handle of handles) sqls.set(handle, makeSql(handle, null));
	const sqlOf = (handle: ClientHandle): Sql => sqls.get(handle) as Sql;
	return {
		admin: sqlOf(admin),
		app: sqlOf(app),
		ro: sqlOf(ro),
		writer: sqlOf(writer),
		async close() {
			for await (const handle of asynchronously(handles)) await handle.close();
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
		return fn(tx);
	});
}
