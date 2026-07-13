import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { compareCostPairWith, costComparisonRequestSchema } from "../src/cost/compare.ts";
import { AgentsViewCostMeter, CostMeterWindowError } from "../src/cost/meter.ts";
import type { QueryResult } from "../src/query/structured.ts";

const window = {
	from: "2026-07-06T05:00:00.000Z",
	to: "2026-07-14T05:00:00.000Z",
	timezone: "America/Chicago",
} as const;

function result(columns: string[], rows: unknown[][], queryRef: string): QueryResult {
	return {
		schema_version: 1,
		columns: columns.map((name) => ({ name, type: name.includes("model") ? "string" : "number" })),
		rows,
		row_count: rows.length,
		execution_ms: 2,
		freshness: { source: "lake", observed_at: "2026-07-13T18:00:00.000Z", window_s: null },
		query_ref: queryRef,
	};
}

describe("cost pairwise comparison", () => {
	it("prices computed rows, honors reported rows, and emits per-session deltas", async () => {
		const run = vi.fn(async (request: { from?: string }) => {
			if (request.from === "model_pricing")
				return result(
					[
						"model_pattern",
						"input_per_mtok",
						"output_per_mtok",
						"cache_creation_per_mtok",
						"cache_read_per_mtok",
					],
					[
						["left-model", 5, 25, 6.25, 0.5],
						["right-model", 5, 25, 6.25, 0.5],
					],
					"q_prices",
				);
			return result(
				[
					"model",
					"session_id",
					"input_tokens",
					"output_tokens",
					"cache_creation_tokens",
					"cache_read_tokens",
					"reported_cost",
					"cost_source",
				],
				[
					["left-model", "l1", 100_000, 20_000, 0, 0, null, "computed"],
					["right-model", "r1", 200_000, 40_000, 0, 0, 7.5, "reported"],
					["right-model", "r2", 100_000, 20_000, 0, 0, null, "computed"],
				],
				"q_usage",
			);
		});

		const comparison = await compareCostPairWith(run, {
			schema_version: 1,
			dimension: "model",
			left: "left-model",
			right: "right-model",
			...window,
		});

		expect(comparison.left).toMatchObject({ cost: 1, tokens: 120_000, sessions: 1 });
		expect(comparison.right).toMatchObject({ cost: 8.5, tokens: 360_000, sessions: 2 });
		expect(comparison.metrics.find(({ key }) => key === "cost_per_session")).toMatchObject({
			left: 1,
			right: 4.25,
			delta: 3.25,
			ratio: 4.25,
		});
		expect(comparison).toMatchObject({
			query_ref: "q_usage",
			pricing_query_ref: "q_prices",
			observed_at: "2026-07-13T18:00:00.000Z",
			receipt: {
				cost_source: "mixed",
				row_count: 3,
				pricing: { effective_row_count: 2 },
			},
		});
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				from: "usage_events",
				where: { model: { op: "in", value: ["left-model", "right-model"] } },
			}),
		);
	});

	it("refuses a silently partial comparison", async () => {
		const run = async (request: { from?: string }) => ({
			...result([], [], request.from === "model_pricing" ? "q_prices" : "q_usage"),
			truncated: request.from === "usage_events",
		});

		await expect(
			compareCostPairWith(run, {
				schema_version: 1,
				dimension: "project",
				left: "console",
				right: "control-plane",
				...window,
			}),
		).rejects.toMatchObject({ code: "comparison_incomplete" });
	});

	it("refuses computed usage with no effective price-book match", async () => {
		const run = async (request: { from?: string }) =>
			request.from === "model_pricing"
				? result(["model_pattern"], [], "q_prices")
				: result(
						[
							"model",
							"session_id",
							"input_tokens",
							"output_tokens",
							"cache_creation_tokens",
							"cache_read_tokens",
							"reported_cost",
						],
						[["unknown-model", "s1", 10, 0, 0, 0, null]],
						"q_usage",
					);

		await expect(
			compareCostPairWith(run, {
				schema_version: 1,
				dimension: "model",
				left: "unknown-model",
				right: "other-model",
				...window,
			}),
		).rejects.toMatchObject({ code: "comparison_unpriced" });
	});

	it("marks a zero baseline ratio unknown and rejects comparing a row to itself", async () => {
		const run = async (request: { from?: string }) =>
			request.from === "model_pricing"
				? result(
						[
							"model_pattern",
							"input_per_mtok",
							"output_per_mtok",
							"cache_creation_per_mtok",
							"cache_read_per_mtok",
						],
						[],
						"q_prices",
					)
				: result(
						[
							"agent",
							"model",
							"session_id",
							"input_tokens",
							"output_tokens",
							"cache_creation_tokens",
							"cache_read_tokens",
							"reported_cost",
							"cost_source",
						],
						[["right", "unpriced", "r1", 10, 0, 0, 0, 1, "reported"]],
						"q_usage",
					);
		const comparison = await compareCostPairWith(run, {
			schema_version: 1,
			dimension: "agent",
			left: "left",
			right: "right",
			...window,
		});
		expect(comparison.metrics.find(({ key }) => key === "cost")?.ratio).toBeNull();
		expect(
			costComparisonRequestSchema.safeParse({
				schema_version: 1,
				dimension: "agent",
				left: "same",
				right: "same",
				...window,
			}).success,
		).toBe(false);
	});

	it("adapts the deployed AgentsView pairwise contract with the exact calendar window", async () => {
		const seen: string[] = [];
		const server = createServer((request, response) => {
			seen.push(request.url ?? "");
			response.setHeader("content-type", "application/json");
			if (request.url?.startsWith("/api/v1/usage/pairwise-comparison"))
				return response.end(
					JSON.stringify({
						left: {
							totalCost: 1,
							inputTokens: 1,
							outputTokens: 2,
							cacheCreationTokens: 3,
							cacheReadTokens: 4,
							totalTokens: 10,
							sessionCount: 1,
							costPerSession: 1,
							tokensPerSession: 10,
						},
						right: {
							totalCost: 2,
							inputTokens: 2,
							outputTokens: 4,
							cacheCreationTokens: 6,
							cacheReadTokens: 8,
							totalTokens: 20,
							sessionCount: 2,
							costPerSession: 1,
							tokensPerSession: 10,
						},
					}),
				);
			if (request.url?.startsWith("/api/v1/usage/summary"))
				return response.end(
					JSON.stringify({
						pricing: {
							source: "fetched",
							table_version: "2026-07-13T14:00:59Z",
							digest: "sha256:test",
							effective_row_count: 1,
							cost_source: "computed",
							models: {
								opus: {
									matched_pattern: "opus",
									input_cost_per_mtok: 5,
									output_cost_per_mtok: 25,
									cache_write_cost_per_mtok: 6.25,
									cache_read_cost_per_mtok: 0.5,
									cost_source: "computed",
								},
							},
						},
					}),
				);
			return response.end(JSON.stringify({ last_sync: "2026-07-13T19:59:07Z" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("test server unavailable");
			const meter = new AgentsViewCostMeter({
				url: `http://127.0.0.1:${String(address.port)}/api/v1`,
			});
			const result = await meter.compare({
				schema_version: 1,
				dimension: "model",
				left: "opus",
				right: "sol",
				...window,
			});
			expect(result).toMatchObject({
				observedAt: "2026-07-13T19:59:07Z",
				pricing: { digest: "sha256:test" },
			});
			expect(seen.find((path) => path.includes("pairwise-comparison"))).toContain(
				"from=2026-07-06&to=2026-07-13&timezone=America%2FChicago",
			);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("does not widen an intraday request for the calendar-day meter", async () => {
		const meter = new AgentsViewCostMeter({ url: "http://127.0.0.1:1/api/v1" });
		await expect(
			meter.compare({
				schema_version: 1,
				dimension: "model",
				left: "opus",
				right: "sol",
				from: "2026-07-06T06:00:00.000Z",
				to: "2026-07-14T05:00:00.000Z",
				timezone: "America/Chicago",
			}),
		).rejects.toBeInstanceOf(CostMeterWindowError);
	});
});
