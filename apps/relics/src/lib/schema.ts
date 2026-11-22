import { Schema } from "effect";

import { creatureModelIds } from "./creatures";

export const CreatureModelId = Schema.Literals(creatureModelIds);
export const CreatureColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

const text = Schema.String.check(Schema.isMaxLength(4000));

const Name = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const FriendName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32));

export const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/));

const Integer = Schema.Finite.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 0, maximum: 65535 }),
);
const Image = Schema.String.check(
	Schema.isMaxLength(1000),
	Schema.isPattern(/^(?:|\/uploads\/[a-zA-Z0-9_./-]+|https:\/\/[^\s]+)$/),
);

export const Email = Schema.Trim.check(
	Schema.isMaxLength(254),
	Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);
export const RelicCard = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	typeId: Schema.NullOr(Schema.Finite),
	varietyId: Schema.NullOr(Schema.Finite),
	indexNumber: Schema.NullOr(Schema.Finite),
	typeName: Schema.String,
	varietyName: Schema.String,
	description: Schema.NullOr(Schema.String),
	lore: Schema.NullOr(Schema.String),
	imageUrl: Schema.NullOr(Schema.String),
	modelId: Schema.NullOr(CreatureModelId),
	color: Schema.NullOr(CreatureColor),
	friendName: Schema.NullOr(Schema.String),
	firstName: Schema.NullOr(Schema.String),
	birthday: Schema.NullOr(Schema.Finite),
	claimed: Schema.Boolean,
	owned: Schema.Boolean,
});
export type RelicCard = typeof RelicCard.Type;
export const Variety = Schema.Struct({
	id: Schema.Finite,
	typeId: Schema.Finite,
	name: Schema.String,
	typeName: Schema.String,
	color: Schema.NullOr(CreatureColor),
	description: Schema.NullOr(Schema.String),
	imageUrl: Schema.NullOr(Schema.String),
});
export type Variety = typeof Variety.Type;

const SetInfo = Schema.Struct({
	id: Schema.Finite,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	imageUrl: Schema.NullOr(Schema.String),
	varietyIds: Schema.Array(Schema.Finite),
});

export const Collection = Schema.Struct({
	name: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	relics: Schema.Array(RelicCard),
	varieties: Schema.Array(Variety),
	sets: Schema.Array(SetInfo),
});
export const Receipt = Schema.Struct({ message: Schema.String });
export const Claim = Schema.Struct({ relicId: Id, name: FriendName, relicName: FriendName });
export const Legacy = Schema.Struct({
	name: Name,
	pin: Schema.String.check(Schema.isPattern(/^\d{4,6}$/)),
});
export const AdminCommand = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("type"),
		modelId: Schema.optional(Schema.NullOr(CreatureModelId)),
		id: Schema.optional(Integer),
		name: Name,
		description: text,
		imageUrl: Image,
	}),
	Schema.Struct({
		kind: Schema.Literal("variety"),
		color: Schema.optional(Schema.NullOr(CreatureColor)),
		id: Schema.optional(Integer),
		typeId: Integer,
		name: Name,
		description: text,
		imageUrl: Image,
	}),
	Schema.Struct({
		kind: Schema.Literal("allocate"),
		typeId: Integer,
		varietyId: Integer,
		start: Integer,
		end: Integer,
		lore: text,
	}),
	Schema.Struct({ kind: Schema.Literal("range"), id: Integer, lore: text }),
	Schema.Struct({ kind: Schema.Literal("written"), rangeId: Integer, index: Integer }),
	Schema.Struct({
		kind: Schema.Literal("reassign"),
		relicId: Id,
		target: Schema.String.check(Schema.isMaxLength(160)),
	}),
	Schema.Struct({
		kind: Schema.Literal("relic"),
		relicId: Id,
		name: Name,
		description: text,
		lore: text,
		imageUrl: Image,
	}),
	Schema.Struct({
		kind: Schema.Literal("set"),
		id: Schema.optional(Integer),
		name: Name,
		description: text,
		imageUrl: Image,
		varietyIds: Schema.Array(Integer),
	}),
	Schema.Struct({ kind: Schema.Literal("deleteSet"), id: Integer }),
]);
export type AdminCommand = typeof AdminCommand.Type;
