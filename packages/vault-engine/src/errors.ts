// oxlint-disable unicorn/throw-new-error -- TaggedError is a class factory, not a constructor.
import { Schema } from "effect";

/** A write the vault refuses. Nothing of it is saved. */
export class WriteRejected extends Schema.TaggedError<WriteRejected>()("WriteRejected", {
	message: Schema.String,
}) {}

/** The secret scan matched. Only rule IDs are carried: the matched text never leaves the scan. */
export class SecretFound extends Schema.TaggedError<SecretFound>()("SecretFound", {
	rules: Schema.Array(Schema.String),
	where: Schema.String,
}) {
	override get message() {
		return `Secret scan rejected the write to ${this.where}: ${this.rules.join(", ")}`;
	}
}

/** A tier file that Loro cannot read. */
export class TierUnreadable extends Schema.TaggedError<TierUnreadable>()("TierUnreadable", {
	tier: Schema.String,
	reason: Schema.String,
}) {
	override get message() {
		return `The ${this.tier} tier file cannot be read: ${this.reason}`;
	}
}
