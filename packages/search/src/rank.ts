// Ranking: turn many providers' local scores into one cross-provider order.
//
// The ranker is PLUGGABLE — the federation core takes a `Ranker` function and
// we ship a sane default. A ranker receives every successful result tagged
// with its provider and must return a final score for each; the core sorts by
// that score (desc) with a stable tiebreak.

import type { Provider, RankedResult, Result } from "./types.ts";

/** A result paired with the provider that produced it, for ranking. */
export interface RankInput {
	readonly result: Result;
	readonly provider: Provider;
	/** 0-based position of `provider` in the federation's provider list. */
	readonly providerIndex: number;
}

/** Knobs for {@link defaultRanker}. */
export interface DefaultRankerOptions {
	/**
	 * Weight of the recency boost, in [0, 1]. 0 disables it. The boost decays exponentially with a
	 * half-life of {@link recencyHalfLifeMs}. Default 0.15.
	 */
	readonly recencyWeight?: number;
	/** Half-life of the recency boost in ms. Default 7 days. */
	readonly recencyHalfLifeMs?: number;
	/** "Now" in ms since epoch; injectable for deterministic tests. */
	readonly now?: number;
}

/**
 * A ranker assigns a final score to a batch of results. Batch (not per-item) so a ranker can
 * normalize across the whole set if it wants. Returned scores need not be in any range; the core
 * only uses them for ordering.
 */
export type Ranker = (inputs: readonly RankInput[]) => readonly number[];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The default ranker: `weight × score (+ optional recency boost)`.
 *
 * - `weight` is the provider's {@link Provider.weight} (default 1). It scales the whole contribution,
 *   so a host can trust some sources more.
 * - `score` is the provider-local relevance in [0, 1], clamped defensively.
 * - The recency boost adds up to `recencyWeight` for a brand-new item and decays with the configured
 *   half-life. Results without a `timestamp` get no boost (neither penalized nor helped).
 *
 * This is intentionally simple and explainable; richer rankers (learned, BM25-blend, etc.) slot in
 * by implementing {@link Ranker}.
 */
export function defaultRanker(options: DefaultRankerOptions = {}): Ranker {
	const recencyWeight = clamp01(options.recencyWeight ?? 0.15);
	const halfLife = options.recencyHalfLifeMs ?? 7 * DAY_MS;
	const now = options.now ?? Date.now();

	return (inputs) =>
		inputs.map(({ result, provider }) => {
			const weight = provider.weight ?? 1;
			const base = weight * clamp01(result.score);
			if (recencyWeight === 0 || result.timestamp === undefined) return base;
			const ageMs = Math.max(0, now - result.timestamp);
			// 2^(-age/halfLife): 1 at age 0, 0.5 at one half-life, → 0 with age.
			const recency = Math.pow(2, -ageMs / halfLife);
			return base + recencyWeight * recency;
		});
}

/**
 * Apply a ranker to inputs and return results sorted best-first, each tagged with its final
 * `rankScore`. Ties break by `providerIndex` then local `score` (both deterministic) so identical
 * queries produce identical ordering.
 */
export function rank(inputs: readonly RankInput[], ranker: Ranker): RankedResult[] {
	const scores = ranker(inputs);
	if (scores.length !== inputs.length) {
		throw new Error(`Ranker returned ${scores.length} scores for ${inputs.length} inputs`);
	}
	return inputs
		.map((input, i) => ({ input, rankScore: scores[i] ?? 0 }))
		.toSorted((a, b) => {
			if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
			if (a.input.providerIndex !== b.input.providerIndex) {
				return a.input.providerIndex - b.input.providerIndex;
			}
			return b.input.result.score - a.input.result.score;
		})
		.map(({ input, rankScore }) => ({ ...input.result, rankScore }));
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return n < 0 ? 0 : n > 1 ? 1 : n;
}
