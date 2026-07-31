import { Schema } from "effect";

const boundedTrimmed = (maximum: number) =>
	Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const ProjectCreate = Schema.Struct({
	commandId: Schema.String.check(Schema.isUUID()),
	scope: boundedTrimmed(128),
	title: boundedTrimmed(256),
	ask: boundedTrimmed(4_000),
});
export type ProjectCreate = typeof ProjectCreate.Type;

export const ProjectCreateReceipt = Schema.Struct({
	commandId: Schema.String,
	objectId: Schema.String,
	versionId: Schema.String,
	versionDigest: Schema.String,
	replayed: Schema.Boolean,
});
export type ProjectCreateReceipt = typeof ProjectCreateReceipt.Type;
