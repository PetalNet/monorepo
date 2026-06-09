import { describe, expect, it } from "vitest";

import { defaultRanker, rank, type RankInput } from "./rank.ts";
import type { Provider, Result } from "./types.ts";

function provider(id: string, weight?: number): Provider {
	return {
		id,
		name: id,
		...(weight !== undefined ? { weight } : {}),
		query: () => Promise.resolve({ results: [] }),
	};
}

function input(providerId: string, weight: number, result: Partial<Result>, index = 0): RankInput {
	return {
		provider: provider(providerId, weight),
		providerIndex: index,
		result: {
			id: result.id ?? "r",
			providerId,
			title: result.title ?? "t",
			score: result.score ?? 0.5,
			kind: "web",
			...(result.timestamp !== undefined ? { timestamp: result.timestamp } : {}),
		},
	};
}

describe("defaultRanker", () => {
	it("computes weight × score with no recency by default-but-timestampless", () => {
		const ranker = defaultRanker({ now: 0 });
		const out = rank([input("a", 2, { id: "x", score: 0.5 })], ranker);
		expect(out[0]?.rankScore).toBeCloseTo(1.0);
	});

	it("adds a recency boost that decays by half-life", () => {
		const now = 1_000_000;
		const halfLife = 1000;
		const ranker = defaultRanker({ now, recencyWeight: 0.2, recencyHalfLifeMs: halfLife });
		// Brand new (age 0): +0.2; one half-life old: +0.1.
		const fresh = rank([input("a", 1, { score: 0.5, timestamp: now })], ranker);
		const old = rank([input("a", 1, { score: 0.5, timestamp: now - halfLife })], ranker);
		expect(fresh[0]?.rankScore).toBeCloseTo(0.5 + 0.2);
		expect(old[0]?.rankScore).toBeCloseTo(0.5 + 0.1);
	});

	it("clamps out-of-range provider scores", () => {
		const ranker = defaultRanker({ now: 0 });
		const out = rank([input("a", 1, { score: 5 })], ranker);
		expect(out[0]?.rankScore).toBeCloseTo(1.0);
	});
});

describe("rank ordering", () => {
	it("sorts best-first and breaks ties by provider order", () => {
		const ranker = defaultRanker({ now: 0 });
		const out = rank(
			[input("b", 1, { id: "b", score: 0.5 }, 1), input("a", 1, { id: "a", score: 0.5 }, 0)],
			ranker,
		);
		// Equal rankScore → lower providerIndex (a) wins.
		expect(out.map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("throws if the ranker returns the wrong number of scores", () => {
		expect(() => rank([input("a", 1, {})], () => [])).toThrow();
	});
});
