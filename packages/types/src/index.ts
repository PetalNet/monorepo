// @petalnet/types — type-only shared definitions. Nothing runtime belongs here
// (runtime helpers go in @petalnet/utils).

/** A non-null JSON-serializable value. Replace/extend as shared types land. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type CostDimension = "agent" | "model" | "project";
export type CostComparisonMetricKey =
	| "cost"
	| "tokens"
	| "sessions"
	| "cost_per_session"
	| "tokens_per_session"
	| "input_tokens"
	| "output_tokens"
	| "cache_creation_tokens"
	| "cache_read_tokens";
export interface CostComparisonRequest {
	readonly schema_version: 1;
	readonly dimension: CostDimension;
	readonly left: string;
	readonly right: string;
	readonly from: string;
	readonly to: string;
	readonly timezone: string;
}
export interface CostComparisonSide {
	readonly value: string;
	readonly cost: number;
	readonly tokens: number;
	readonly sessions: number;
	readonly cost_per_session: number;
	readonly tokens_per_session: number;
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cache_creation_tokens: number;
	readonly cache_read_tokens: number;
}
export interface CostComparisonMetric {
	readonly key: CostComparisonMetricKey;
	readonly left: number;
	readonly right: number;
	readonly delta: number;
	readonly ratio: number | null;
}
export interface CostComparisonReceipt {
	readonly source: "query_plane" | "agentsview";
	readonly scope: string;
	readonly query: string;
	readonly row_count: number;
	readonly session_count: number;
	readonly execution_ms: number | null;
	readonly cost_source: "computed" | "reported" | "mixed";
	readonly pricing: {
		readonly source: string;
		readonly table_version: string;
		readonly digest: string;
		readonly effective_row_count: number;
		readonly models: readonly {
			readonly model: string;
			readonly matched_pattern: string;
			readonly input_per_mtok: number;
			readonly output_per_mtok: number;
			readonly cache_creation_per_mtok: number;
			readonly cache_read_per_mtok: number;
		}[];
	};
}
export interface CostComparisonResult {
	readonly schema_version: 1;
	readonly dimension: CostDimension;
	readonly left: CostComparisonSide;
	readonly right: CostComparisonSide;
	readonly metrics: readonly CostComparisonMetric[];
	readonly query_ref: string;
	readonly pricing_query_ref: string;
	readonly observed_at: string;
	readonly receipt: CostComparisonReceipt;
}
