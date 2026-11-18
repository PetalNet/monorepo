import { operation, operationError } from "@petalnet/effect-api";
import { Effect, Schema } from "effect";
import { PlatformError } from "effect/PlatformError";

import { SecretFound, TierUnreadable, WriteRejected } from "./errors.ts";
import { ClaimCard, recallClaims, reindex, renderCard } from "./recall.ts";
import { RememberInput, remember } from "./research.ts";
import { Claim, Text, Tier } from "./schema.ts";

/** Brings the read side, the claim index, up to date after a write. */
const refresh = Effect.asVoid(reindex);

const errors = {
	WriteRejected: operationError(WriteRejected, { status: 422, message: (error) => error.message }),
	SecretFound: operationError(SecretFound, { status: 422, message: (error) => error.message }),
	TierUnreadable: operationError(TierUnreadable, { status: 500 }),
	PlatformError: operationError(PlatformError, { status: 500 }),
};

const tier = Schema.optionalKey(Tier);

const RecallInput = Schema.Struct({
	query: Text,
	k: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
	tiers: Schema.optionalKey(
		Schema.Array(Tier).annotate({ description: "Limit results to these tiers. Default: all." }),
	),
});

const recall = Effect.fnUntraced(function* (input: typeof RecallInput.Type) {
	const options = { k: input.k ?? 8, ...(input.tiers === undefined ? {} : { tiers: input.tiers }) };
	const claims = yield* recallClaims(input.query, options);

	return { claims, text: claims.map(renderCard).join("\n") || "No claim matches." };
});

/** The vault's agent surface. Every write refreshes the read side before it returns. */
export const operations = [
	operation({
		name: "recall",
		description:
			"Search the vault's claims. Each result is one claim with its topic and heading, its sources and how fresh they are. Cite claims by ID. Call this before researching or answering from memory.",
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
			"Add a single claim to a topic. Give `source` (a vault source ID) or `direct` (who said or observed it, with the quote). A claim with neither is stored as a GUESS.",
		input: Schema.Struct({ ...RememberInput.fields, tier }),
		output: Claim,
		handler: ({ tier: chosen, ...input }) =>
			remember(chosen ?? "shared", input).pipe(Effect.tap(() => refresh)),
		errors,
	}),
];
