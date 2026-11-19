import { Schema } from "effect";

const Id = Schema.Int.check(Schema.isGreaterThan(0));

export const SnapshotRequest = Schema.Struct({});
export const DeliveryControl = Schema.Struct({ paused: Schema.Boolean });
export const DropRequest = Schema.Struct({
	id: Id,
	reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export const SnoozeRequest = Schema.Struct({
	id: Id,
	hours: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(720)),
});
export const Snapshot = Schema.Struct({
	paused: Schema.Boolean,
	scheduler: Schema.Literals(["active", "paused", "missing", "unavailable"]),
	lastSweep: Schema.NullOr(Schema.String),
	items: Schema.Array(
		Schema.Struct({
			id: Id,
			kind: Schema.Literals(["promise", "reminder"]),
			text: Schema.String,
			due: Schema.Number,
			created: Schema.Number,
			room: Schema.String,
			surface: Schema.String,
			event: Schema.String,
			escalated: Schema.Boolean,
		}),
	),
});
export type Snapshot = typeof Snapshot.Type;
