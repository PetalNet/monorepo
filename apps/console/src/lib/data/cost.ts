import type { GovernanceItem, GovernancePool } from "$lib/api/types";
import type {
	CostComparisonMetricKey,
	CostComparisonResult,
	CostComparisonSide,
	CostDimension,
} from "@petalnet/types";

export type {
	CostComparisonMetric,
	CostComparisonMetricKey,
	CostComparisonReceipt,
	CostComparisonRequest,
	CostComparisonResult,
	CostComparisonSide,
	CostDimension,
} from "@petalnet/types";

export interface DailyCost {
	day: string;
	spend: number;
	prior: number;
	forecast?: number;
}
export interface CostBreakdown {
	id: string;
	label: string;
	spend: number | null;
	share: number;
	rate?: string;
	unpricedTokens?: number;
}
export interface AgentCost {
	handle: string;
	host: string;
	spend: number;
	tokens: string;
	mix: { label: string; share: number }[];
	spark: number[];
	governance: GovernanceItem;
}
export interface CostSession {
	id: string;
	started: string;
	agent: string;
	model: string;
	taskId?: number;
	tokens: string;
	spend: number;
	math: { kind: string; tokens: number; rate: number; dollars: number }[];
	source: "computed" | "reported" | "mixed";
}
export interface PriceRow {
	model: string;
	input: number;
	output: number;
	write: number | null;
	read: number;
	unpricedTokens?: number;
}

const comparisonSeeds: Record<
	CostDimension,
	Record<string, Omit<CostComparisonSide, "value" | "cost_per_session" | "tokens_per_session">>
> = {
	agent: {
		"carson-2": {
			cost: 14.02,
			tokens: 7_080_000,
			sessions: 2,
			input_tokens: 420_000,
			output_tokens: 240_000,
			cache_creation_tokens: 320_000,
			cache_read_tokens: 6_100_000,
		},
		janet: {
			cost: 9.77,
			tokens: 5_280_000,
			sessions: 3,
			input_tokens: 310_000,
			output_tokens: 170_000,
			cache_creation_tokens: 0,
			cache_read_tokens: 4_800_000,
		},
		"point-fable": {
			cost: 8.91,
			tokens: 4_300_000,
			sessions: 4,
			input_tokens: 260_000,
			output_tokens: 140_000,
			cache_creation_tokens: 0,
			cache_read_tokens: 3_900_000,
		},
		codex: {
			cost: 4.1,
			tokens: 1_205_000,
			sessions: 2,
			input_tokens: 150_000,
			output_tokens: 55_000,
			cache_creation_tokens: 0,
			cache_read_tokens: 1_000_000,
		},
	},
	model: {
		"claude-opus-4-8": {
			cost: 27.3,
			tokens: 15_200_000,
			sessions: 8,
			input_tokens: 740_000,
			output_tokens: 410_000,
			cache_creation_tokens: 610_000,
			cache_read_tokens: 13_440_000,
		},
		"claude-fable-5": {
			cost: 7.6,
			tokens: 4_580_000,
			sessions: 5,
			input_tokens: 260_000,
			output_tokens: 140_000,
			cache_creation_tokens: 280_000,
			cache_read_tokens: 3_900_000,
		},
		"gpt-5.5": {
			cost: 2.6,
			tokens: 1_205_000,
			sessions: 2,
			input_tokens: 150_000,
			output_tokens: 55_000,
			cache_creation_tokens: 0,
			cache_read_tokens: 1_000_000,
		},
		"claude-haiku-4-5": {
			cost: 2.1,
			tokens: 2_440_000,
			sessions: 6,
			input_tokens: 190_000,
			output_tokens: 90_000,
			cache_creation_tokens: 160_000,
			cache_read_tokens: 2_000_000,
		},
		"claude-sonnet-5": {
			cost: 1.6,
			tokens: 1_340_000,
			sessions: 4,
			input_tokens: 120_000,
			output_tokens: 70_000,
			cache_creation_tokens: 150_000,
			cache_read_tokens: 1_000_000,
		},
	},
	project: {
		"Lab Console": {
			cost: 19.8,
			tokens: 10_300_000,
			sessions: 9,
			input_tokens: 680_000,
			output_tokens: 350_000,
			cache_creation_tokens: 370_000,
			cache_read_tokens: 8_900_000,
		},
		"Library backfill": {
			cost: 12.3,
			tokens: 7_100_000,
			sessions: 7,
			input_tokens: 420_000,
			output_tokens: 220_000,
			cache_creation_tokens: 260_000,
			cache_read_tokens: 6_200_000,
		},
		"Neighborhood infra": {
			cost: 6.1,
			tokens: 3_410_000,
			sessions: 5,
			input_tokens: 260_000,
			output_tokens: 150_000,
			cache_creation_tokens: 200_000,
			cache_read_tokens: 2_800_000,
		},
	},
};

export function mockCostComparison(
	dimension: CostDimension,
	leftValue: string,
	rightValue: string,
): CostComparisonResult {
	const side = (value: string): CostComparisonSide => {
		const seed = comparisonSeeds[dimension][value] ?? {
			cost: 0,
			tokens: 0,
			sessions: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_tokens: 0,
			cache_read_tokens: 0,
		};
		return {
			value,
			...seed,
			cost_per_session: seed.sessions === 0 ? 0 : seed.cost / seed.sessions,
			tokens_per_session: seed.sessions === 0 ? 0 : seed.tokens / seed.sessions,
		};
	};
	const left = side(leftValue);
	const right = side(rightValue);
	const keys: CostComparisonMetricKey[] = [
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
	return {
		schema_version: 1,
		dimension,
		left,
		right,
		metrics: keys.map((key) => ({
			key,
			left: left[key],
			right: right[key],
			delta: right[key] - left[key],
			ratio: left[key] === 0 ? null : right[key] / left[key],
		})),
		query_ref: "fixture:cost-pairwise",
		pricing_query_ref: "fixture:price-book",
		observed_at: new Date().toISOString(),
		receipt: {
			source: "agentsview",
			scope: `${dimension}: ${leftValue} ↔ ${rightValue}`,
			query: `GET /usage/pairwise-comparison?left_dimension=${dimension}&left_value=${encodeURIComponent(leftValue)}&right_dimension=${dimension}&right_value=${encodeURIComponent(rightValue)}`,
			row_count: left.sessions + right.sessions,
			session_count: left.sessions + right.sessions,
			execution_ms: 18,
			cost_source: "computed",
			pricing: {
				source: "fixture",
				table_version: "2026-07-13T14:00:59Z",
				digest: "sha256:fixture-price-book",
				effective_row_count: 5,
				models: [leftValue, rightValue].map((model) => ({
					model,
					matched_pattern: model,
					input_per_mtok: 5,
					output_per_mtok: 25,
					cache_creation_per_mtok: 6.25,
					cache_read_per_mtok: 0.5,
				})),
			},
		},
	};
}

const expires = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;
export const mockGovernance: GovernanceItem[] = [
	{
		agent: "carson-2",
		light: "yellow",
		tokens_spent: 640_000,
		granted_tokens: 800_000,
		grant_expires_epoch: expires(22),
		tier: "opus",
		rate_limit_hits: 0,
	},
	{
		agent: "janet",
		light: "green",
		tokens_spent: 210_000,
		granted_tokens: 400_000,
		grant_expires_epoch: expires(72),
		tier: "opus",
		rate_limit_hits: 0,
	},
	{
		agent: "point-fable",
		light: "yellow",
		tokens_spent: 285_000,
		granted_tokens: 400_000,
		grant_expires_epoch: expires(41),
		tier: "opus",
		rate_limit_hits: 0,
	},
	{
		agent: "scout",
		light: "green",
		tokens_spent: 88_000,
		granted_tokens: 200_000,
		grant_expires_epoch: expires(72),
		tier: "sonnet",
		rate_limit_hits: 0,
	},
	{
		agent: "derek",
		light: "green",
		tokens_spent: 27_000,
		granted_tokens: 200_000,
		grant_expires_epoch: expires(120),
		tier: "haiku",
		rate_limit_hits: 0,
	},
	{
		agent: "codex",
		light: "yellow",
		tokens_spent: 170_000,
		granted_tokens: 200_000,
		grant_expires_epoch: expires(48),
		tier: "opus",
		rate_limit_hits: 0,
	},
];
export const mockPool: GovernancePool = {
	pool_tokens: 2_200_000,
	pool_spent: 1_420_000,
	fleet_mode: "parallel",
	cascade_active: false,
};
export const daily: DailyCost[] = [
	{ day: "Mon 6", spend: 5.7, prior: 5.1 },
	{ day: "Tue 7", spend: 9.84, prior: 5.5 },
	{ day: "Wed 8", spend: 7.1, prior: 5.8 },
	{ day: "Thu 9", spend: 6.6, prior: 6.4 },
	{ day: "Fri 10", spend: 7.8, prior: 6.1 },
	{ day: "Sat 11", spend: 4.16, prior: 5.7 },
	{ day: "Sun 12", spend: 0, prior: 5.2, forecast: 5.9 },
];
export const breakdowns: Record<"agent" | "model" | "project", CostBreakdown[]> = {
	agent: [
		{ id: "carson-2", label: "carson-2", spend: 14.02, share: 34 },
		{ id: "janet", label: "janet", spend: 9.77, share: 24 },
		{ id: "point-fable", label: "point-fable", spend: 8.91, share: 22 },
		{ id: "codex", label: "codex", spend: 4.1, share: 10 },
		{ id: "other", label: "2 more · $4.40", spend: 4.4, share: 10 },
	],
	model: [
		{ id: "opus", label: "claude-opus-4-8", spend: 27.3, share: 66, rate: "5.00 · 25.00 /Mtok" },
		{ id: "fable", label: "claude-fable-5", spend: 7.6, share: 18, rate: "10.00 · 50.00 /Mtok" },
		{ id: "gpt", label: "gpt-5.5", spend: 2.6, share: 6, rate: "5.00 · 20.00 /Mtok" },
		{ id: "haiku", label: "claude-haiku-4-5", spend: 2.1, share: 5, rate: "1.00 · 5.00 /Mtok" },
		{ id: "sonnet", label: "claude-sonnet-5", spend: 1.6, share: 4, rate: "2.00 · 10.00 /Mtok" },
	],
	project: [
		{ id: "console", label: "Lab Console", spend: 19.8, share: 48 },
		{ id: "library", label: "Library backfill", spend: 12.3, share: 30 },
		{ id: "infra", label: "Neighborhood infra", spend: 6.1, share: 15 },
		{ id: "other", label: "3 more · $3.00", spend: 3, share: 7 },
	],
};
export const agents: AgentCost[] = [
	{
		handle: "carson-2",
		host: ".14 · builder",
		spend: 14.02,
		tokens: "in 0.42M · out 0.24M · cache 6.1M",
		mix: [
			{ label: "opus-4-8", share: 79 },
			{ label: "fable-5", share: 13 },
			{ label: "other", share: 8 },
		],
		spark: [4, 13, 6, 5, 8, 4, 4],
		governance: mockGovernance[0]!,
	},
	{
		handle: "janet",
		host: ".202 · helm",
		spend: 9.77,
		tokens: "in 0.31M · out 0.17M · cache 4.8M",
		mix: [
			{ label: "opus-4-8", share: 88 },
			{ label: "sonnet-5", share: 9 },
			{ label: "other", share: 3 },
		],
		spark: [5, 6, 7, 6, 9, 7, 8],
		governance: mockGovernance[1]!,
	},
	{
		handle: "point-fable",
		host: ".14 · builder",
		spend: 8.91,
		tokens: "in 0.26M · out 0.14M · cache 3.9M",
		mix: [
			{ label: "fable-5", share: 64 },
			{ label: "opus-4-8", share: 29 },
			{ label: "other", share: 7 },
		],
		spark: [3, 5, 4, 10, 7, 9, 7],
		governance: mockGovernance[2]!,
	},
];
export const sessions: CostSession[] = [
	{
		id: "a1f4c2e8",
		started: "Tue 14:02",
		agent: "carson-2",
		model: "claude-opus-4-8",
		taskId: 512,
		tokens: "in 240k · out 140k · cache 2.8M",
		spend: 7.1,
		source: "computed",
		math: [
			{ kind: "input", tokens: 240000, rate: 5, dollars: 1.2 },
			{ kind: "output", tokens: 140000, rate: 25, dollars: 3.5 },
			{ kind: "cache write", tokens: 160000, rate: 6.25, dollars: 1 },
			{ kind: "cache read", tokens: 2800000, rate: 0.5, dollars: 1.4 },
		],
	},
	{
		id: "b209d",
		started: "Sat 20:14",
		agent: "janet",
		model: "claude-opus-4-8",
		taskId: 718,
		tokens: "in 96k · out 41k · cache 1.2M",
		spend: 3.84,
		source: "mixed",
		math: [],
	},
	{
		id: "c331e",
		started: "Thu 09:32",
		agent: "point-fable",
		model: "mixed · 3",
		taskId: 701,
		tokens: "in 84k · out 52k · cache 990k",
		spend: 2.92,
		source: "computed",
		math: [],
	},
	{
		id: "d402f",
		started: "Fri 16:08",
		agent: "codex",
		model: "gpt-5.5",
		tokens: "in 150k · out 55k · cache 1.0M",
		spend: 2.35,
		source: "reported",
		math: [],
	},
	{
		id: "e592a",
		started: "Fri 11:20",
		agent: "carson-2",
		model: "claude-fable-5",
		taskId: 512,
		tokens: "in 30k · out 18k · cache 550k",
		spend: 1.75,
		source: "computed",
		math: [],
	},
];
export const prices: PriceRow[] = [
	{ model: "claude-opus-4-8", input: 5, output: 25, write: 6.25, read: 0.5 },
	{ model: "claude-fable-5", input: 10, output: 50, write: 12.5, read: 1 },
	{ model: "claude-sonnet-5", input: 2, output: 10, write: 2.5, read: 0.2 },
	{ model: "claude-haiku-4-5", input: 1, output: 5, write: 1.25, read: 0.1 },
	{ model: "gpt-5.5", input: 5, output: 20, write: null, read: 0.5 },
];
