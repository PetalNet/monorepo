import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Effect, Layer, Schema } from "effect";
import { Query, type Scalar } from "effect-qb";
import * as Pg from "effect-qb/postgres";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";

import {
	Counter,
	ParsedSproutId,
	type CreateSprout,
	type Sprout,
	type SproutIdValue,
} from "../../sprouts/schema";
import {
	ActorAuthority,
	ActorDenied,
	type ActorPrincipal,
	type AuthorityError,
} from "../actors/authority";
import { sprouts } from "../db/tables";
import { InvocationContext } from "../invocation";

export class SproutNotFound extends Error {
	readonly _tag = "SproutNotFound";

	constructor(readonly id: string) {
		super(`Sprout ${id} was not found`);
	}
}

export class SproutDatabaseError extends Error {
	readonly _tag = "SproutDatabaseError";

	constructor(readonly cause: unknown) {
		super("The sprout database is unavailable", { cause });
	}
}

export type SproutError = AuthorityError | SproutNotFound | SproutDatabaseError;

export interface SproutCommandsShape {
	readonly list: Effect.Effect<readonly Sprout[], SproutError, InvocationContext>;
	readonly get: (id: SproutIdValue) => Effect.Effect<Sprout, SproutError, InvocationContext>;
	readonly create: (input: CreateSprout) => Effect.Effect<Sprout, SproutError, InvocationContext>;
	readonly water: (id: SproutIdValue) => Effect.Effect<Sprout, SproutError, InvocationContext>;
	readonly remove: (
		id: SproutIdValue,
	) => Effect.Effect<{ readonly removed: true }, SproutError, InvocationContext>;
}

export class SproutCommands extends Context.Service<SproutCommands, SproutCommandsShape>()(
	"grove/SproutCommands",
) {}

const unavailableDuringBuild = () => Effect.die("Sprout data is unavailable during build");

export const SproutCommandsBuildLayer = Layer.succeed(SproutCommands, {
	list: unavailableDuringBuild(),
	get: unavailableDuringBuild,
	create: unavailableDuringBuild,
	water: unavailableDuringBuild,
	remove: unavailableDuringBuild,
});

interface SproutRow {
	readonly id: Scalar.BigIntString;
	readonly name: string;
	readonly planted_at: Scalar.InstantString;
	readonly waterings: Counter;
	readonly created_by_actor_id: string | null;
	readonly last_actor_id: string | null;
}

class SproutOutOfDate extends Error {
	readonly _tag = "SproutOutOfDate";
}

const sproutSelection = {
	id: sprouts.id,
	name: sprouts.name,
	planted_at: sprouts.planted_at,
	waterings: sprouts.waterings,
	created_by_actor_id: sprouts.created_by_actor_id,
	last_actor_id: sprouts.last_actor_id,
};

const fromRow = (row: SproutRow): Sprout => ({
	id: `sprout-${row.id}`,
	name: row.name,
	plantedAt: row.planted_at,
	waterings: row.waterings,
	createdByActorId: row.created_by_actor_id,
	lastActorId: row.last_actor_id,
});

const databaseId = (id: SproutIdValue): Effect.Effect<Scalar.BigIntString, SproutNotFound> =>
	Schema.decodeUnknownEffect(ParsedSproutId)(id).pipe(
		Effect.map(([, value]) => value),
		Effect.mapError(() => new SproutNotFound(id)),
	);

const hasId = (id: Scalar.BigIntString) => Query.eq(sprouts.id, Query.cast(id, Pg.Type.int8()));

const database = <A>(effect: Effect.Effect<A, unknown>) =>
	effect.pipe(Effect.mapError((cause) => new SproutDatabaseError(cause)));

export const SproutCommandsLayer = Layer.effect(
	SproutCommands,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const authority = yield* ActorAuthority;
		const executor = Pg.Executor.make();
		const execute = <Rows>(effect: Effect.Effect<Rows, unknown, SqlClient.SqlClient>) =>
			effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
		const list = database(
			execute(
				executor.execute(
					Query.select(sproutSelection).pipe(Query.from(sprouts), Query.orderBy(sprouts.id)),
				),
			),
		).pipe(Effect.map((rows) => rows.map(fromRow)));
		const get = (id: SproutIdValue) =>
			Effect.gen(function* () {
				const dbId = yield* databaseId(id);
				const rows = yield* database(
					execute(
						executor.execute(
							Query.select(sproutSelection).pipe(Query.from(sprouts), Query.where(hasId(dbId))),
						),
					),
				);
				const row = rows.at(0);
				return row ? fromRow(row) : yield* Effect.fail(new SproutNotFound(id));
			});
		const command = <A, E>(
			operation: string,
			run: (actor: ActorPrincipal) => Effect.Effect<A, E>,
		): Effect.Effect<A, E | AuthorityError | SproutDatabaseError, InvocationContext> =>
			Effect.flatMap(InvocationContext, ({ principal }) => {
				if (principal.kind !== "person" && principal.kind !== "agent")
					return Effect.fail(new ActorDenied("An enrolled actor is required"));
				return sql
					.withTransaction(
						authority.authorizeActor(principal, operation).pipe(Effect.andThen(run(principal))),
					)
					.pipe(
						Effect.mapError((error) =>
							error instanceof SqlError ? new SproutDatabaseError(error) : error,
						),
					);
			});
		return {
			list: command("sprouts.list", () => list),
			get: (id) => command("sprouts.get", () => get(id)),
			create: (input) =>
				command("sprouts.create", (actor) =>
					database(
						execute(
							executor.execute(
								Query.insert(sprouts, {
									name: input.name,
									created_by_actor_id: actor.actorId,
									last_actor_id: actor.actorId,
								}).pipe(Query.returning(sproutSelection)),
							),
						),
					).pipe(Effect.map((rows) => fromRow(rows[0]))),
				),
			water: (id) =>
				command("sprouts.water", (actor) =>
					Effect.gen(function* () {
						const dbId = yield* databaseId(id);
						const rows = yield* execute(
							Pg.Executor.withTransaction(
								Effect.gen(function* () {
									const current = yield* executor.execute(
										Query.select(sproutSelection).pipe(
											Query.from(sprouts),
											Query.where(hasId(dbId)),
										),
									);
									const row = current.at(0);
									if (!row) return [];
									const waterings = yield* Schema.decodeUnknownEffect(Counter)(row.waterings + 1);

									const updated = yield* executor.execute(
										Query.update(sprouts, { waterings, last_actor_id: actor.actorId }).pipe(
											Query.where(
												Query.and(hasId(dbId), Query.eq(sprouts.waterings, row.waterings)),
											),
											Query.returning(sproutSelection),
										),
									);
									if (updated.length > 0) return updated;
									return yield* Effect.fail(new SproutOutOfDate());
								}),
							),
						).pipe(
							Effect.tapError((error) =>
								error instanceof SproutOutOfDate
									? Effect.sleep("10 millis")
									: Effect.succeed(undefined),
							),
							Effect.retry({
								times: 10,
								while: (error) => error instanceof SproutOutOfDate,
							}),
							Effect.mapError((cause) => new SproutDatabaseError(cause)),
						);
						const row = rows.at(0);
						return row ? fromRow(row) : yield* Effect.fail(new SproutNotFound(id));
					}),
				),
			remove: (id) =>
				command("sprouts.remove", () =>
					Effect.gen(function* () {
						const dbId = yield* databaseId(id);
						const rows = yield* database(
							execute(
								executor.execute(
									Query.delete(sprouts).pipe(
										Query.where(hasId(dbId)),
										Query.returning({ id: sprouts.id }),
									),
								),
							),
						);
						if (rows.length === 0) return yield* Effect.fail(new SproutNotFound(id));
						return { removed: true as const };
					}),
				),
		};
	}),
);
