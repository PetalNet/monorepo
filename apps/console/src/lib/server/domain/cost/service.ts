import type {
	CostComparisonReceipt,
	CostComparisonRequest,
	CostComparisonResult,
	CostComparisonSide,
} from "@petalnet/types";
import { Effect } from "effect";

import type { Sql } from "../db/pool.ts";
import { edge } from "../edge.ts";
import { QueryError, runStructured } from "../query/structured.ts";
import { compareCostPairWith, metricRows } from "./compare.ts";
import {
	CostMeterUnavailableError,
	CostMeterWindowError,
	type CostMeter,
	type MeterComparison,
	type MeterSide,
} from "./meter.ts";

export class CostComparisonUnavailableError extends Error {
	readonly _tag = "CostComparisonUnavailableError";
}

function meterSide(value: string, side: MeterSide): CostComparisonSide {
	return {
		value,
		cost: side.totalCost,
		tokens: side.totalTokens,
		sessions: side.sessionCount,
		cost_per_session: side.costPerSession ?? 0,
		tokens_per_session: side.tokensPerSession ?? 0,
		input_tokens: side.inputTokens,
		output_tokens: side.outputTokens,
		cache_creation_tokens: side.cacheCreationTokens,
		cache_read_tokens: side.cacheReadTokens,
	};
}

function meterResult(input: CostComparisonRequest, result: MeterComparison): CostComparisonResult {
	const left = meterSide(input.left, result.left);
	const right = meterSide(input.right, result.right);
	return {
		schema_version: 1,
		dimension: input.dimension,
		left,
		right,
		metrics: metricRows(left, right),
		query_ref: `agentsview:${result.observedAt}:pairwise`,
		pricing_query_ref: `agentsview:${result.pricing.digest}`,
		observed_at: result.observedAt,
		receipt: {
			source: "agentsview",
			scope: `${input.dimension}: ${input.left} ↔ ${input.right}`,
			query: result.query,
			row_count: 2,
			session_count: left.sessions + right.sessions,
			execution_ms: result.executionMs,
			cost_source: ["computed", "reported", "mixed"].includes(result.pricing.cost_source)
				? (result.pricing.cost_source as CostComparisonReceipt["cost_source"])
				: "mixed",
			pricing: {
				source: result.pricing.source,
				table_version: result.pricing.table_version,
				digest: result.pricing.digest,
				effective_row_count: result.pricing.effective_row_count,
				models: Object.entries(result.pricing.models).map(([model, rate]) => ({
					model,
					matched_pattern: rate.matched_pattern,
					input_per_mtok: rate.input_cost_per_mtok,
					output_per_mtok: rate.output_cost_per_mtok,
					cache_creation_per_mtok: rate.cache_write_cost_per_mtok,
					cache_read_per_mtok: rate.cache_read_cost_per_mtok,
				})),
			},
		},
	};
}

/**
 * Pairwise cost comparison as an Effect with a deliberately narrow error channel: a `QueryError`
 * (the request is unanswerable from the price book / usage lake) or, when the structured path
 * reports an unknown source and a meter fallback is authorized, a `CostComparisonUnavailableError`.
 * The structured queries compose directly (`runStructured` is already an Effect); the AgentsView
 * meter is an external HTTP adapter, so its call is the one promise edge — lifted with `edge(...)`
 * so its two failure modes land in the error channel instead of being swallowed as defects.
 */
export function compareCostPair(
	app: Sql,
	scopes: readonly string[],
	input: CostComparisonRequest,
	meter?: CostMeter,
): Effect.Effect<CostComparisonResult, QueryError | CostComparisonUnavailableError> {
	return compareCostPairWith((request) => runStructured(app, scopes, request), input).pipe(
		Effect.catch((error) => {
			if (error.code !== "bad_from" || !meter || !scopes.includes("fleet"))
				return Effect.fail(error);
			return edge(
				(cause): cause is CostMeterWindowError | CostMeterUnavailableError =>
					cause instanceof CostMeterWindowError || cause instanceof CostMeterUnavailableError,
				() => meter.compare(input),
			).pipe(
				Effect.map((result) => meterResult(input, result)),
				Effect.catch(
					(meterError): Effect.Effect<never, QueryError | CostComparisonUnavailableError> =>
						meterError instanceof CostMeterWindowError
							? Effect.fail(new QueryError("comparison_window_unsupported", meterError.message))
							: Effect.fail(new CostComparisonUnavailableError(meterError.message)),
				),
			);
		}),
	);
}
