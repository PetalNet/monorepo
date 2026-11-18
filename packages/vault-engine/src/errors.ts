// oxlint-disable unicorn/throw-new-error -- TaggedError is a class factory, not a constructor.
import { Schema } from "effect";

/** A write the vault refuses. Nothing of it is saved. */
export class WriteRejected extends Schema.TaggedError<WriteRejected>()("WriteRejected", {
	message: Schema.String,
}) {}

/** A tier file that Loro cannot read. */
export class TierUnreadable extends Schema.TaggedError<TierUnreadable>()("TierUnreadable", {
	tier: Schema.String,
	reason: Schema.String,
}) {
	override get message() {
		return `The ${this.tier} tier file cannot be read: ${this.reason}`;
	}
}
