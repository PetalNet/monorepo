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

	it("is deterministic: input order does not change the output order", () => {
		const ranker = defaultRanker({ now: 0 });
		// A set with score ties (so tiebreaks matter) and distinct providerIndexes.
		const items: RankInput[] = [
			input("p0", 1, { id: "a", score: 0.5 }, 0),
			input("p1", 1, { id: "b", score: 0.9 }, 1),
			input("p2", 1, { id: "c", score: 0.5 }, 2),
			input("p3", 2, { id: "d", score: 0.5 }, 3),
			input("p1", 1, { id: "e", score: 0.5 }, 1),
		];
		const forward = rank(items, ranker).map((r) => r.id);
		const reversed = rank(items.toReversed(), ranker).map((r) => r.id);
		// Same multiset in, identical order out regardless of presentation order.
		expect(reversed).toEqual(forward);
		// And the order is the expected one: d (0.5*2=1.0), b (0.9), then the
		// score-0.5 weight-1 trio broken by providerIndex ascending: a(0), e(1), c(2).
		expect(forward).toEqual(["d", "b", "a", "e", "c"]);
	});

	it("breaks a full tie (same rankScore AND providerIndex) by local score", () => {
		const out = rank(
			[
				input("same", 1, { id: "lo", score: 0.4 }, 0),
				input("same", 1, { id: "hi", score: 0.6 }, 0),
			],
			// Force identical rankScores so only the local-score tiebreak applies.
			(inputs) => inputs.map(() => 1),
		);
		expect(out.map((r) => r.id)).toEqual(["hi", "lo"]);
	});
});
