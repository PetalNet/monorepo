import { AsyncLocalStorage } from "node:async_hooks";

import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { effectPgCodecs } from "drizzle-orm/effect-postgres/codecs";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Effect, type ManagedRuntime, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

type RunSql = <A>(effect: Effect.Effect<A, SqlError>) => Promise<A>;
const rawResult = Schema.Struct({ rows: Schema.Array(Schema.Unknown), rowCount: Schema.Finite });

export const makeDatabase = (pg: PgClient.PgClient) =>
	PgDrizzle.makeWithDefaults({
		codecs: {
			...effectPgCodecs,
			// Effect PgClient decodes int8 as bigint; string-mode identities stay JSON-safe.
			"bigint:string": { ...effectPgCodecs["bigint:string"], normalize: String },
		},
	}).pipe(Effect.provideService(PgClient.PgClient, pg));

// Better Auth's Promise callbacks borrow the application pool. Its scoped runtime
// owns callback fibers; transaction callbacks carry the reserved connection context.
export const makeAuthDatabase = (
	pg: PgClient.PgClient,
	runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>,
) => {
	const runners = new AsyncLocalStorage<RunSql>();
	const db = drizzle(async (text, params, method) => {
		const run: RunSql = runners.getStore() ?? ((effect) => runtime.runPromise(effect));

		const statement = pg.unsafe(text, params);

		if (method === "all") {
			return { rows: [...(await run(statement.values))] };
		}

		const result = Schema.decodeUnknownSync(rawResult)(await run(statement.raw));

		return { rows: Object.assign([...result.rows], { rowCount: result.rowCount }) };
	});

	return Object.assign(db, {
		transaction: <A>(callback: (tx: typeof db) => Promise<A>): Promise<A> =>
			runtime.runPromise(
				pg.withTransaction(
					Effect.gen(function* () {
						const context = yield* Effect.context();

						return yield* Effect.promise((signal) =>
							runners.run(
								(effect) => runtime.runPromise(Effect.provide(effect, context), { signal }),
								() => callback(db),
							),
						);
					}),
				),
			),
	});
};
