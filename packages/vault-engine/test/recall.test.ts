import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";

import { recallClaims, reindex, renderCard } from "../src/recall.ts";
import { SOURCE, claimInput, seed, test, write } from "./tools.ts";

describe("recall", () => {
	test("finds a claim by its note title and heading, not only its own words", () =>
		Effect.gen(function* () {
			const claim = yield* write("shared", (tx) =>
				seed(tx).pipe(Effect.andThen(tx.addClaim(claimInput("Propositions beat passages.")))),
			);

			yield* reindex;

			expect((yield* recallClaims("granularity"))[0]).toMatchObject({
				id: claim.id,
				title: "Note granularity",
				heading: "Retrieval unit",
			});

			expect(yield* recallClaims("kubernetes")).toEqual([]);
		}));

	test("returns each claim with its source", () =>
		Effect.gen(function* () {
			const claim = yield* write("shared", (tx) =>
				seed(tx).pipe(Effect.andThen(tx.addClaim(claimInput("Propositions beat passages.")))),
			);

			yield* reindex;

			const [fresh] = yield* recallClaims("propositions");

			expect(fresh && renderCard(fresh)).toBe(
				`[${claim.id}] Note granularity > Retrieval unit: Propositions beat passages. | PRIMARY | supports Dense X Retrieval (${SOURCE}, 2026-11-01)`,
			);
		}));
});
