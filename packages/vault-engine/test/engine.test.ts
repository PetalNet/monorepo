import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";

import { WriteRejected } from "../src/errors.ts";
import { TOPIC, addClaim, claimInput, seeded, state, test, write } from "./tools.ts";

describe("write checks", () => {
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
});
