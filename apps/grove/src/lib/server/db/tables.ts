import { Check, Column, Function, Query } from "effect-qb";
import * as Pg from "effect-qb/postgres";

import { Counter } from "../../sprouts/schema.ts";

const publicSchema = Pg.Schema.make("public");

export const sprouts = publicSchema
	.table("grove_demo_sprouts", {
		id: Pg.Column.int8().pipe(Pg.Column.identityAlways, Column.primaryKey),
		name: Column.text(),
		planted_at: Pg.Column.timestamptz().pipe(Column.default(Function.now())),
		waterings: Column.int().pipe(Column.default(Query.literal(0)), Column.schema(Counter)),
	})
	.pipe(
		Check.make("grove_demo_sprouts_waterings_nonnegative", (table) =>
			Query.gte(table.waterings, 0),
		),
	);
