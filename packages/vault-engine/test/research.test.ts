import { createHash } from "node:crypto";

import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";

import { Vault } from "../src/engine.ts";
import { remember } from "../src/research.ts";
import { SOURCE, seeded, state, test } from "./tools.ts";

describe("remember", () => {
	test("records who said it as a DIRECT source and quotes a known source", () =>
		Effect.gen(function* () {
			yield* seeded;

			const said = yield* remember("shared", {
				text: "The owner locked option A.",
				topic: "Note granularity",
				direct: { title: "Owner in chat 2026-11-17", quote: "A and test on first real tests" },
			});
			const cited = yield* remember("shared", {
				text: "Recall rises.",
				topic: "Note granularity",
				source: SOURCE,
				quote: "Recall@5 +12.0",
			});

			expect(said.sourceType).toBe("DIRECT");

			expect((yield* (yield* Vault).view).source(said.links[0]?.target ?? "")).toMatchObject({
				kind: "direct",
				sourceType: "DIRECT",
			});

			expect(cited.links).toEqual([
				{
					rel: "source",
					target: SOURCE,
					passage: `p-${createHash("sha256").update("Recall@5 +12.0").digest("hex").slice(0, 10)}`,
				},
			]);
		}));

	test("gives the same speaker in two tiers, or two short or non-Latin names, distinct sources", () =>
		Effect.gen(function* () {
			yield* seeded;

			const target = (claim: { links: readonly { target: string }[] }) => claim.links[0]?.target;
			const shared = yield* remember("shared", {
				text: "Said in shared.",
				topic: "Note granularity",
				direct: { title: "Eli", quote: "one" },
			});
			const personal = yield* remember("personal", {
				text: "Said in personal.",
				topic: "Private",
				direct: { title: "Eli", quote: "two" },
			});
			const other = yield* remember("shared", {
				text: "Another.",
				topic: "Note granularity",
				direct: { title: "田中", quote: "はい" },
			});

			expect(new Set([target(shared), target(personal), target(other)]).size).toBe(3);
			expect((yield* (yield* Vault).view).source(target(shared) ?? "")?.title).toBe("Eli");
		}));

	test("refuses a quote that names no source", () =>
		Effect.gen(function* () {
			yield* seeded;

			expect(
				(yield* Effect.flip(
					remember("shared", {
						text: "Claim.",
						topic: "Note granularity",
						quote: "floating quote",
					}),
				)).message,
			).toMatch(/quote needs the source/);

			expect((yield* state("shared")).claims).toEqual({});
		}));
});
