import { Schema } from "effect";

export const EmptyInput = Schema.Struct({});

const SproutDatabaseId = Schema.String.pipe(
	Schema.check(Schema.isStringBigInt(), Schema.isPattern(/^[1-9][0-9]*$/)),
	Schema.brand("BigIntString"),
);

export const SproutIdValue = Schema.TemplateLiteral(["sprout-", SproutDatabaseId]).check(
	Schema.isPattern(/^sprout-[1-9][0-9]*$/),
);
export const ParsedSproutId = Schema.TemplateLiteralParser(["sprout-", SproutDatabaseId]);

export const SproutId = Schema.Struct({
	id: SproutIdValue,
});

export const WaterSprout = Schema.Struct({
	...SproutId.fields,
});

export const CreateSprout = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
});

export const SproutIdValidator = Schema.toStandardSchemaV1(SproutId);
export const WaterSproutValidator = Schema.toStandardSchemaV1(WaterSprout);
export const CreateSproutValidator = Schema.toStandardSchemaV1(CreateSprout);

export const Counter = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
	Schema.isLessThanOrEqualTo(2_147_483_647),
).pipe(Schema.brand("Counter"));

export const Sprout = Schema.Struct({
	id: SproutIdValue,
	name: Schema.String,
	plantedAt: Schema.String,
	waterings: Counter,
	createdByActorId: Schema.NullOr(Schema.String),
	lastActorId: Schema.NullOr(Schema.String),
});

export const SproutList = Schema.Array(Sprout);

export const RemovedSprout = Schema.Struct({ removed: Schema.Boolean });

export type Sprout = typeof Sprout.Type;
export type Counter = typeof Counter.Type;
export type CreateSprout = typeof CreateSprout.Type;
export type SproutIdValue = typeof SproutIdValue.Type;
export type WaterSprout = typeof WaterSprout.Type;
