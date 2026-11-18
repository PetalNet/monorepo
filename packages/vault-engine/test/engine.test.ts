import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";
import { LoroDoc } from "loro-crdt";

import { Vault } from "../src/engine.ts";
import { WriteRejected } from "../src/errors.ts";
import {
	SOURCE,
	TOPIC,
	addClaim,
	claimInput,
	exists,
	seed,
	seeded,
	state,
	stored,
	test,
	write,
} from "./tools.ts";

describe("documents", () => {
	test("stores claims and sources as plain values keyed by their ID, one document per tier", () =>
		Effect.gen(function* () {
			const vault = yield* Vault;
			const claim = yield* write("shared", (tx) =>
				seed(tx).pipe(
					Effect.andThen(tx.addClaim(claimInput("Claims retrieve better than passages."))),
				),
			);
			const doc = LoroDoc.fromSnapshot(yield* vault.snapshot("shared"));

			// A plain value comes back as a JS object; a nested Loro container would come back as a container.
			expect(doc.getMap("claims").get(claim.id)).toMatchObject({ id: claim.id, text: claim.text });
			expect(doc.getMap("sources").get(SOURCE)).toMatchObject({ id: SOURCE });
			expect(yield* exists(vault.file("shared"))).toBe(true);
			expect(yield* exists(vault.file("personal"))).toBe(false);
		}));
});

describe("write checks", () => {
	test("requires a source for anything that is not a guess", () =>
		Effect.gen(function* () {
			yield* seeded;

			expect(
				(yield* Effect.flip(addClaim("shared", { ...claimInput("Unsourced."), links: [] })))
					.message,
			).toMatch(/needs a source/);

			expect(
				yield* Effect.flip(
					addClaim("shared", {
						...claimInput("Cites nothing real."),
						links: [{ rel: "supports", target: "src-ffffffffffffffffffff" }],
					}),
				),
			).toBeInstanceOf(WriteRejected);

			expect(
				(yield* addClaim("shared", { ...claimInput("A hunch."), links: [], sourceType: "GUESS" }))
					.sourceType,
			).toBe("GUESS");
		}));

	test("checks every record against its schema", () =>
		Effect.gen(function* () {
			yield* seeded;

			for (const attempt of [
				write("shared", (tx) =>
					tx.putTopic({ id: "t-bad", title: "Two\nlines", summary: "x", headings: [] }),
				),
				write("shared", (tx) =>
					tx.putTopic({ id: "Not an ID", title: "Ok", summary: "x", headings: [] }),
				),
				addClaim("shared", { ...claimInput("Claim\n## Dependents") }),
			]) {
				expect(yield* Effect.flip(attempt)).toBeInstanceOf(WriteRejected);
			}

			expect(Object.keys((yield* state("shared")).topics)).toEqual([TOPIC]);
			expect((yield* state("shared")).claims).toEqual({});
		}));

	test("leaves nothing of a refused source behind when the write carries on", () =>
		Effect.gen(function* () {
			yield* write("shared", (tx) =>
				tx
					.putSource({
						id: "doc-0000000000000002",
						kind: "research",
						title: "Half valid",
						sourceType: "DERIVED",
						captured: "2026-10-18T00:00:00.000Z",
						passages: { s1: "Fine.", "Not an ID": "Refused." },
					})
					.pipe(
						Effect.flip,
						Effect.andThen(
							tx.putTopic({
								id: "t-after",
								title: "After",
								summary: "Written after.",
								headings: [],
							}),
						),
					),
			);

			expect(Object.keys((yield* state("shared")).sources)).toEqual([]);
			expect(Object.keys((yield* state("shared")).topics)).toEqual(["t-after"]);
			expect(yield* stored("shared")).not.toContain("Half valid");
		}));

	test("never changes a passage once it is written", () =>
		Effect.gen(function* () {
			yield* seeded;

			const error = yield* Effect.flip(
				write("shared", (tx) =>
					tx.putSource({
						id: SOURCE,
						kind: "capture",
						title: "Dense X Retrieval",
						url: `https://example.org/${SOURCE}`,
						sourceType: "PRIMARY",
						captured: "2026-11-01T00:00:00.000Z",
						passages: { p1: "Different text." },
					}),
				),
			);

			expect(error.message).toMatch(/already holds different text/);

			expect((yield* state("shared")).sources[SOURCE]?.passages).toEqual({
				p1: "Proposition indexing raises Recall@5.",
			});
		}));
});
