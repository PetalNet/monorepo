// oxlint-disable unicorn/throw-new-error -- TaggedError is a class factory, not a constructor.
import { Schema } from "effect";

/** A write the vault refuses. Nothing of it is saved. */
export class WriteRejected extends Schema.TaggedError<
	WriteRejected,
	{ readonly brand: unique symbol }
>()("WriteRejected", {
	message: Schema.String,
}) {}

/** The secret scan matched. Only rule IDs are carried: the matched text never leaves the scan. */
export class SecretFound extends Schema.TaggedError<
	SecretFound,
	{ readonly brand: unique symbol }
>()("SecretFound", {
	rules: Schema.Array(Schema.String),
	where: Schema.String,
}) {
	override get message() {
		return `Secret scan rejected the write to ${this.where}: ${this.rules.join(", ")}`;
	}
}

/** Vault-cite did not save a reference. Record it as a gap. */
export class CaptureFailed extends Schema.TaggedError<
	CaptureFailed,
	{ readonly brand: unique symbol }
>()("CaptureFailed", {
	ref: Schema.String,
	reason: Schema.String,
}) {
	override get message() {
		return `vault-cite did not save ${this.ref}: ${this.reason}`;
	}
}

/** A tier file that Loro cannot read. */
export class TierUnreadable extends Schema.TaggedError<
	TierUnreadable,
	{ readonly brand: unique symbol }
>()("TierUnreadable", {
	tier: Schema.String,
	reason: Schema.String,
}) {
	override get message() {
		return `The ${this.tier} tier file cannot be read: ${this.reason}`;
	}
}
