import type { QueryResult } from "../query/structured.ts";

export type PanelType =
	| "bar"
	| "line"
	| "stat"
	| "table"
	| "pie"
	| "scatter"
	| "gauge"
	| "heatmap"
	| "histogram"
	| "insight"
	| "text"
	| "refusal";

export interface ForecastSpec {
	strategy?: "auto" | "linear" | "drift" | "moving_average" | "exp_smoothing" | "seasonal_naive";
	horizon?: number;
	window?: number | null;
	alpha?: number | null;
	season_length?: number | null;
	confidence?: "high" | "medium" | "low" | null;
	interval_pct?: number | null;
}

export interface PanelSpecV2 {
	schema_version: 2;
	type: PanelType;
	title: string;
	description?: string | null;
	query_ref?: string | null;
	encoding?: Record<string, unknown> | null;
	prose?: string | null;
	refusal?: { reason: string; suggestions?: string[] } | null;
	summary?: string | null;
	narrative?: string | null;
	confidence?: "high" | "medium" | "low" | null;
	recommendations?: string[] | null;
	suggestions?: string[] | null;
	forecast?: ForecastSpec | null;
	layout?: Record<string, unknown> | null;
	live?: Record<string, unknown> | null;
	render?: RenderArtifact | null;
}

export interface VegaLiteSpec {
	readonly $schema: "https://vega.github.io/schema/vega-lite/v6.json";
	readonly [key: string]: unknown;
}

export interface RenderArtifact {
	schema_version: 1;
	renderer: "vega-lite" | "native";
	spec: VegaLiteSpec | null;
	data_query_ref: string | null;
	selection_reason: string;
	forecast_strategy: string | null;
	bindings?: {
		binding: string;
		query_ref: string | null;
		column: string;
		value: unknown;
		status: "resolved" | "refused";
	}[];
}

export interface MaterializedPanel {
	schema_version: 1;
	panel: PanelSpecV2;
	result: QueryResult | null;
	render: RenderArtifact;
}
