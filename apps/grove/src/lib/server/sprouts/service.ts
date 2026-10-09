import * as PgClient from "@effect/sql-pg/PgClient";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";

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
import { makeDatabase } from "../db/client";
import { sprouts } from "../db/tables";
import { InvocationContext } from "../invocation";

export class SproutNotFound extends Data.TaggedError("SproutNotFound")<{ readonly id: string }> {
	override get message() {
		return `Sprout ${this.id} was not found`;
	}
}

export class SproutDatabaseError extends Data.TaggedError("SproutDatabaseError")<{
	readonly cause: unknown;
}> {
	override get message() {
		return "The sprout database is unavailable";
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

/**
 * InvocationContext is per request, not a dependency to capture when building the shared layer.
 *
 * @effect-expect-leaking InvocationContext
 */
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
	readonly id: string;
	readonly name: string;
	readonly planted_at: string;
	readonly waterings: number;
	readonly created_by_actor_id: string | null;
	readonly last_actor_id: string | null;
}

class SproutOutOfDate extends Data.TaggedError("SproutOutOfDate") {}

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
	waterings: Schema.decodeSync(Counter)(row.waterings),
	createdByActorId: row.created_by_actor_id,
	lastActorId: row.last_actor_id,
});

const databaseId = (id: SproutIdValue): Effect.Effect<string, SproutNotFound> =>
	Schema.decodeEffect(ParsedSproutId)(id).pipe(
		Effect.map(([, value]) => value),
		Effect.mapError(() => new SproutNotFound({ id })),
	);

const hasId = (id: string) => eq(sprouts.id, id);

const database = <A, E>(effect: Effect.Effect<A, E>) =>
	effect.pipe(Effect.mapError((cause) => new SproutDatabaseError({ cause })));

export const SproutCommandsLayer = Layer.effect(
	SproutCommands,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const authority = yield* ActorAuthority;
		const db = yield* makeDatabase(sql);

		const list = database(db.select(sproutSelection).from(sprouts).orderBy(sprouts.id)).pipe(
			Effect.map((rows) => rows.map(fromRow)),
		);
		const get = (id: SproutIdValue) =>
			Effect.gen(function* () {
				const dbId = yield* databaseId(id);
				const rows = yield* database(db.select(sproutSelection).from(sprouts).where(hasId(dbId)));
				const row = rows.at(0);

				return row ? fromRow(row) : yield* new SproutNotFound({ id });
			});
		const command = <A, E>(
			operation: string,
			run: (actor: ActorPrincipal) => Effect.Effect<A, E>,
		): Effect.Effect<A, E | AuthorityError | SproutDatabaseError, InvocationContext> =>
			Effect.flatMap(InvocationContext, ({ principal }) => {
				if (principal.kind !== "person" && principal.kind !== "agent") {
					return Effect.fail(new ActorDenied({ reason: "An enrolled actor is required" }));
				}

				return sql
					.withTransaction(
						authority.authorizeActor(principal, operation).pipe(Effect.andThen(run(principal))),
					)
					.pipe(
						Effect.catchTag("SqlError", (cause) => Effect.fail(new SproutDatabaseError({ cause }))),
					);
			});

		return {
			list: command("sprouts.list", () => list),
			get: (id) => command("sprouts.get", () => get(id)),
			create: (input) =>
				command("sprouts.create", (actor) =>
					database(
						db
							.insert(sprouts)
							.values({
								name: input.name,
								created_by_actor_id: actor.actorId,
								last_actor_id: actor.actorId,
							})
							.returning(sproutSelection),
					).pipe(Effect.map((rows) => fromRow(rows[0]))),
				),
			water: (id) =>
				command("sprouts.water", (actor) =>
					Effect.gen(function* () {
						const dbId = yield* databaseId(id);
						const rows = yield* sql
							.withTransaction(
								Effect.gen(function* () {
									const current = yield* db
										.select(sproutSelection)
										.from(sprouts)
										.where(hasId(dbId));
									const row = current.at(0);

									if (!row) {
										return [];
									}

									const waterings = yield* Schema.decodeEffect(Counter)(row.waterings + 1);

									const updated = yield* db
										.update(sprouts)
										.set({ waterings, last_actor_id: actor.actorId })
										.where(and(hasId(dbId), eq(sprouts.waterings, row.waterings)))
										.returning(sproutSelection);

									if (updated.length > 0) {
										return updated;
									}

									return yield* new SproutOutOfDate();
								}),
							)
							.pipe(
								Effect.tapErrorTag("SproutOutOfDate", () => Effect.sleep("10 millis")),
								Effect.retry({
									times: 10,
									while: Predicate.isTagged("SproutOutOfDate"),
								}),
								Effect.mapError((cause) => new SproutDatabaseError({ cause })),
							);
						const row = rows.at(0);

						return row ? fromRow(row) : yield* new SproutNotFound({ id });
					}),
				),
			remove: (id) =>
				command("sprouts.remove", () =>
					Effect.gen(function* () {
						const dbId = yield* databaseId(id);
						const rows = yield* database(
							db.delete(sprouts).where(hasId(dbId)).returning({ id: sprouts.id }),
						);

						if (rows.length === 0) {
							return yield* new SproutNotFound({ id });
						}

						return { removed: true as const };
					}),
				),
		};
	}),
);
