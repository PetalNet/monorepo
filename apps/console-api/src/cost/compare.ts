import { createHash } from "node:crypto";

import type {
	CostComparisonMetric,
	CostComparisonRequest,
	CostComparisonResult,
	CostComparisonSide,
} from "@petalnet/types";
import { z } from "zod";

import { QueryError, runStructured, type QueryResult } from "../query/structured.ts";

export const costComparisonRequestSchema = z
	.object({
		schema_version: z.literal(1),
		dimension: z.enum(["agent", "model", "project"]),
		left: z.string().min(1).max(256),
		right: z.string().min(1).max(256),
		from: z.string().datetime({ offset: true }),
		to: z.string().datetime({ offset: true }),
		timezone: z.string().min(1).max(64),
	})
	.strict()
	.refine(({ left, right }) => left !== right, {
		message: "comparison values must be different",
		path: ["right"],
	})
	.refine(
		({ timezone }) => {
			try {
				new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
				return true;
			} catch {
				return false;
			}
		},
		{
			message: "timezone must be an IANA time zone",
			path: ["timezone"],
		},
	);

export type { CostComparisonRequest, CostComparisonResult } from "@petalnet/types";

type Runner = (request: Parameters<typeof runStructured>[2]) => Promise<QueryResult>;

function records(result: QueryResult): Record<string, unknown>[] {
	return result.rows.map((row) =>
		Object.fromEntries(result.columns.map((column, index) => [column.name, row[index]])),
	);
}

function finite(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function metricRows(
	left: CostComparisonSide,
	right: CostComparisonSide,
): CostComparisonMetric[] {
	const keys: CostComparisonMetric["key"][] = [
		"cost",
		"tokens",
		"sessions",
		"cost_per_session",
		"tokens_per_session",
		"input_tokens",
		"output_tokens",
		"cache_creation_tokens",
		"cache_read_tokens",
	];
	return keys.map((key) => ({
		key,
		left: left[key],
		right: right[key],
		delta: right[key] - left[key],
		ratio: left[key] === 0 ? null : right[key] / left[key],
	}));
}

/**
 * Cost is derived at query time. A provider-reported row wins; otherwise the four token kinds are
 * priced against the same model price book read whose reference is returned with the comparison.
 */
export async function compareCostPairWith(
	run: Runner,
	input: CostComparisonRequest,
): Promise<CostComparisonResult> {
	const usageRequest: Parameters<typeof runStructured>[2] = {
		schema_version: 1,
		mode: "structured",
		from: "usage_events",
		group_by: [...new Set([input.dimension, "model", "session_id", "cost_status", "cost_source"])],
		select: [
			{ field: "input_tokens", agg: "sum", as: "input_tokens" },
			{ field: "output_tokens", agg: "sum", as: "output_tokens" },
			{
				field: "cache_creation_input_tokens",
				agg: "sum",
				as: "cache_creation_tokens",
			},
			{
				field: "cache_read_input_tokens",
				agg: "sum",
				as: "cache_read_tokens",
			},
			{ field: "cost_usd", agg: "sum", as: "reported_cost" },
		],
		where: { [input.dimension]: { op: "in", value: [input.left, input.right] } },
		time: { from: input.from, to: input.to },
		limit: 100_000,
	};
	const pricingRequest: Parameters<typeof runStructured>[2] = {
		schema_version: 1,
		mode: "structured",
		from: "model_pricing",
		select: [
			{ field: "model_pattern" },
			{ field: "input_per_mtok" },
			{ field: "output_per_mtok" },
			{ field: "cache_creation_per_mtok" },
			{ field: "cache_read_per_mtok" },
			{ field: "updated_at" },
		],
		limit: 1_000,
	};
	const [usage, pricing] = await Promise.all([run(usageRequest), run(pricingRequest)]);
	if (usage.truncated || pricing.truncated)
		throw new QueryError(
			"comparison_incomplete",
			"cost comparison exceeded the complete-query limit; narrow the time window",
		);
	const priceRows = records(pricing)
		.map((row) => ({
			pattern: String(row["model_pattern"]),
			updatedAt: String(row["updated_at"] ?? pricing.freshness.observed_at),
			rate: {
				input: finite(row["input_per_mtok"]),
				output: finite(row["output_per_mtok"]),
				creation: finite(row["cache_creation_per_mtok"]),
				read: finite(row["cache_read_per_mtok"]),
			},
		}))
		.sort((a, b) => a.pattern.localeCompare(b.pattern));
	const normalizeModel = (value: string) =>
		value
			.trim()
			.toLowerCase()
			.replace(/^(?:openai|anthropic|google|vertex|bedrock)\//, "")
			.replaceAll("_", "-");
	const canonicalModel = (value: string) =>
		normalizeModel(value)
			.replace(/(?::latest|@[a-z0-9._-]+)$/i, "")
			.replace(/-\d{4}-?\d{2}-?\d{2}$/i, "");
	const matchRate = (model: string) => {
		const exact = priceRows.find(({ pattern }) => pattern === model);
		if (exact) return exact;
		const normalized = normalizeModel(model);
		const normalizedMatch = priceRows.find(({ pattern }) => normalizeModel(pattern) === normalized);
		if (normalizedMatch) return normalizedMatch;
		const canonical = canonicalModel(model);
		return priceRows.find(({ pattern }) => canonicalModel(pattern) === canonical);
	};
	const effectiveRates = new Map<string, (typeof priceRows)[number]>();
	const costSources = new Set<"computed" | "reported">();
	const accumulators = new Map(
		[input.left, input.right].map((value) => [
			value,
			{
				value,
				cost: 0,
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_tokens: 0,
				cache_read_tokens: 0,
				sessionIds: new Set<string>(),
			},
		]),
	);
	for (const row of records(usage)) {
		const value = String(row[input.dimension] ?? "");
		const accumulator = accumulators.get(value);
		if (!accumulator) continue;
		const model = String(row["model"] ?? "");
		const matched = matchRate(model);
		const inputTokens = finite(row["input_tokens"]);
		const outputTokens = finite(row["output_tokens"]);
		const creationTokens = finite(row["cache_creation_tokens"]);
		const readTokens = finite(row["cache_read_tokens"]);
		const reportedCost = row["reported_cost"] == null ? null : finite(row["reported_cost"]);
		costSources.add(reportedCost === null ? "computed" : "reported");
		if (
			reportedCost === null &&
			!matched &&
			inputTokens + outputTokens + creationTokens + readTokens > 0
		)
			throw new QueryError(
				"comparison_unpriced",
				`no effective price-book match for model ${model}; comparison refused`,
			);
		if (matched) effectiveRates.set(model, matched);
		const computedCost = matched
			? (inputTokens * matched.rate.input +
					outputTokens * matched.rate.output +
					creationTokens * matched.rate.creation +
					readTokens * matched.rate.read) /
				1_000_000
			: 0;
		// The query partitions each session/model by cost_source, so reported and computed usage can
		// never be collapsed into one aggregate. A present provider amount (including $0) wins for
		// that partition; a null amount is priced from its four token counters.
		accumulator.cost += reportedCost === null ? computedCost : reportedCost;
		accumulator.input_tokens += inputTokens;
		accumulator.output_tokens += outputTokens;
		accumulator.cache_creation_tokens += creationTokens;
		accumulator.cache_read_tokens += readTokens;
		accumulator.sessionIds.add(String(row["session_id"] ?? "unknown"));
	}
	const side = (value: string): CostComparisonSide => {
		const item = accumulators.get(value)!;
		const sessions = item.sessionIds.size;
		const tokens =
			item.input_tokens + item.output_tokens + item.cache_creation_tokens + item.cache_read_tokens;
		return {
			value,
			cost: item.cost,
			tokens,
			sessions,
			cost_per_session: sessions === 0 ? 0 : item.cost / sessions,
			tokens_per_session: sessions === 0 ? 0 : tokens / sessions,
			input_tokens: item.input_tokens,
			output_tokens: item.output_tokens,
			cache_creation_tokens: item.cache_creation_tokens,
			cache_read_tokens: item.cache_read_tokens,
		};
	};
	const left = side(input.left);
	const right = side(input.right);
	const tableVersion = priceRows.reduce(
		(latest, row) => (row.updatedAt > latest ? row.updatedAt : latest),
		pricing.freshness.observed_at,
	);
	const digest = `sha256:${createHash("sha256").update(JSON.stringify(priceRows)).digest("hex")}`;
	return {
		schema_version: 1,
		dimension: input.dimension,
		left,
		right,
		metrics: metricRows(left, right),
		query_ref: usage.query_ref,
		pricing_query_ref: pricing.query_ref,
		observed_at: usage.freshness.observed_at,
		receipt: {
			source: "query_plane",
			scope: `${input.dimension}: ${input.left} ↔ ${input.right}`,
			query: JSON.stringify({ usage: usageRequest, pricing: pricingRequest }),
			row_count: usage.row_count,
			session_count: left.sessions + right.sessions,
			execution_ms: usage.execution_ms,
			cost_source:
				costSources.size > 1 ? "mixed" : (costSources.values().next().value ?? "computed"),
			pricing: {
				source: pricing.freshness.source,
				table_version: tableVersion,
				digest,
				effective_row_count: pricing.row_count,
				models: [...effectiveRates].map(([model, { pattern, rate }]) => ({
					model,
					matched_pattern: pattern,
					input_per_mtok: rate.input,
					output_per_mtok: rate.output,
					cache_creation_per_mtok: rate.creation,
					cache_read_per_mtok: rate.read,
				})),
			},
		},
	};
}
