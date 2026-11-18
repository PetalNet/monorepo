import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";

import { Vault } from "../src/engine.ts";
import { remember } from "../src/research.ts";
import { seeded, test } from "./tools.ts";

describe("remember", () => {
	test("records who said it as a DIRECT source", () =>
		Effect.gen(function* () {
			yield* seeded;

			const said = yield* remember("shared", {
				text: "The owner locked option A.",
				topic: "Note granularity",
				direct: { title: "Owner in chat 2026-11-17", quote: "A and test on first real tests" },
			});

			expect(said.sourceType).toBe("DIRECT");

			expect((yield* (yield* Vault).view).source(said.links[0]?.target ?? "")).toMatchObject({
				kind: "direct",
				sourceType: "DIRECT",
			});
		}));
});
