import { operation, operationError } from "@petalnet/effect-api";
import { Effect, Schema } from "effect";
import { PlatformError } from "effect/PlatformError";

import { TierUnreadable, WriteRejected } from "./errors.ts";
import { ClaimCard, recallClaims, reindex, renderCard } from "./recall.ts";
import { RememberInput, remember } from "./research.ts";
import { Claim, Text } from "./schema.ts";

/** Brings the read side, the claim index, up to date after a write. */
const refresh = Effect.asVoid(reindex);

const errors = {
	WriteRejected: operationError(WriteRejected, { status: 422, message: (error) => error.message }),
	TierUnreadable: operationError(TierUnreadable, { status: 500 }),
	PlatformError: operationError(PlatformError, { status: 500 }),
};

const RecallInput = Schema.Struct({
	query: Text,
	k: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});

const recall = Effect.fnUntraced(function* (input: typeof RecallInput.Type) {
	const claims = yield* recallClaims(input.query, { k: input.k ?? 8 });

	return { claims, text: claims.map(renderCard).join("\n") || "No claim matches." };
});

/** The vault's agent surface. Every write refreshes the read side before it returns. */
export const operations = [
	operation({
		name: "recall",
		description:
			"Search the vault's claims. Each result is one claim with its topic and heading and its sources. Cite claims by ID. Call this before researching or answering from memory.",
		input: RecallInput,
		output: Schema.Struct({
			claims: Schema.Array(ClaimCard),
			text: Schema.String,
		}),
		handler: recall,
		errors,
	}),
	operation({
		name: "remember",
		description:
			"Add a single claim to a topic. Give `direct` (who said or observed it, with the quote). A claim without it is stored as a GUESS.",
		input: RememberInput,
		output: Claim,
		handler: (input) => remember("shared", input).pipe(Effect.tap(() => refresh)),
		errors,
	}),
];
