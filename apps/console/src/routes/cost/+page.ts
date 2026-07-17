import type { QueryResult } from "$lib/api/types";
import {
	agents,
	breakdowns,
	daily,
	mockGovernance,
	mockPool,
	prices,
	sessions,
	type AgentCost,
	type CostBreakdown,
	type CostSession,
	type DailyCost,
	type PriceRow,
} from "$lib/data/cost";
import { dataMode, readExecutors, readGovernance, runQuery } from "$lib/rpc/browser";

import { formatUnknown } from "#format";

import type { PageLoad } from "./$types";

type Range = "Today" | "7d" | "30d";

const rangeDays: Record<Range, number> = { Today: 1, "7d": 7, "30d": 30 };
const number = (value: unknown): number => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
};

function records(result: QueryResult): Record<string, unknown>[] {
	return result.rows.map((row) =>
		Object.fromEntries(result.columns.map((column, index) => [column.name, row[index]])),
	);
}

function dayLabel(value: unknown): string {
	const date = new Date(String(value));
	return Number.isNaN(date.getTime())
		? "Unknown"
		: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

export const load: PageLoad = async ({ fetch, parent, url }) => {
	const shell = await parent();
	const requestedRange = url.searchParams.get("range");
	const range: Range =
		requestedRange === "Today" || requestedRange === "30d" ? requestedRange : "7d";
	const now = new Date();
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - (rangeDays[range] - 1));
	const end = new Date(now);
	end.setHours(0, 0, 0, 0);
	end.setDate(end.getDate() + 1);
	const ledgerWindow = {
		from: start.toISOString(),
		to: end.toISOString(),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
	if (dataMode() === "mock")
		return {
			ledgerAvailable: true,
			governanceAvailable: true,
			controlPlaneLive: true,
			isMock: true,
			range,
			ledgerWindow,
			observedAt: new Date().toISOString(),
			governance: mockGovernance,
			pool: mockPool,
			daily,
			breakdowns,
			agents,
			sessions,
			prices,
			summary: {
				spend: sessions.reduce((sum, session) => sum + session.spend, 0),
				tokens: sessions.reduce(
					(sum, session) => sum + session.math.reduce((lineSum, line) => lineSum + line.tokens, 0),
					0,
				),
				queryRef: "fixture:cost-summary",
			},
			pricingQueryRef: "fixture:price-book",
			lanes: shell.me.lanes,
		};

	const [governance, executors, usage, priceBook] = await Promise.all([
		readGovernance(fetch).catch(() => null),
		readExecutors(fetch).catch(() => null),
		runQuery(
			{
				schema_version: 1,
				mode: "structured",
				from: "usage_events",
				group_by: ["session_id", "started_at", "agent", "model", "project", "task_id"],
				select: [
					{ field: "input_tokens", agg: "sum", as: "input_tokens" },
					{ field: "output_tokens", agg: "sum", as: "output_tokens" },
					{ field: "cache_creation_input_tokens", agg: "sum", as: "cache_creation_tokens" },
					{ field: "cache_read_input_tokens", agg: "sum", as: "cache_read_tokens" },
					{ field: "cost_usd", agg: "sum", as: "reported_cost" },
				],
				time: { from: ledgerWindow.from, to: ledgerWindow.to },
				order: [{ field: "reported_cost", dir: "desc" }],
				limit: 100000,
			},
			fetch,
		).catch(() => null),
		runQuery(
			{
				schema_version: 1,
				mode: "structured",
				from: "model_pricing",
				select: [
					{ field: "model_pattern" },
					{ field: "input_per_mtok" },
					{ field: "output_per_mtok" },
					{ field: "cache_creation_per_mtok" },
					{ field: "cache_read_per_mtok" },
				],
				order: [{ field: "model_pattern", dir: "asc" }],
				limit: 1000,
			},
			fetch,
		).catch(() => null),
	]);

	const livePrices: PriceRow[] = priceBook
		? records(priceBook).map((row) => ({
				model: String(row["model_pattern"]),
				input: number(row["input_per_mtok"]),
				output: number(row["output_per_mtok"]),
				write:
					row["cache_creation_per_mtok"] == null ? null : number(row["cache_creation_per_mtok"]),
				read: number(row["cache_read_per_mtok"]),
			}))
		: [];
	const rates = new Map(livePrices.map((price) => [price.model, price]));
	const usageRows = usage ? records(usage) : [];
	const liveSessions: CostSession[] = usageRows.map((row) => {
		const model = formatUnknown(row["model"] ?? "unpriced");
		const rate = rates.get(model);
		const lines = [
			{ kind: "input", tokens: number(row["input_tokens"]), rate: rate?.input ?? 0 },
			{ kind: "output", tokens: number(row["output_tokens"]), rate: rate?.output ?? 0 },
			{ kind: "cache write", tokens: number(row["cache_creation_tokens"]), rate: rate?.write ?? 0 },
			{ kind: "cache read", tokens: number(row["cache_read_tokens"]), rate: rate?.read ?? 0 },
		].map((line) => ({ ...line, dollars: (line.tokens * line.rate) / 1_000_000 }));
		const reported = number(row["reported_cost"]);
		const computed = lines.reduce((sum, line) => sum + line.dollars, 0);
		const totalTokens = lines.reduce((sum, line) => sum + line.tokens, 0);
		return {
			id: String(row["session_id"]),
			started: String(row["started_at"]),
			agent: formatUnknown(row["agent"] ?? "unknown"),
			model,
			...(Number.isInteger(Number(row["task_id"])) ? { taskId: Number(row["task_id"]) } : {}),
			tokens: `${(totalTokens / 1_000_000).toFixed(2)}M total`,
			spend: reported || computed,
			math: lines,
			source: reported > 0 ? (computed > 0 ? "mixed" : "reported") : "computed",
			queryRef: usage?.query_ref,
			project: formatUnknown(row["project"] ?? "unassigned"),
		};
	});

	const totalSpend = liveSessions.reduce((sum, session) => sum + session.spend, 0);
	const totalTokens = usageRows.reduce(
		(sum, row) =>
			sum +
			number(row["input_tokens"]) +
			number(row["output_tokens"]) +
			number(row["cache_creation_tokens"]) +
			number(row["cache_read_tokens"]),
		0,
	);
	const makeBreakdown = (field: "agent" | "model" | "project"): CostBreakdown[] => {
		const totals = new Map<string, number>();
		for (const [index, session] of liveSessions.entries()) {
			const label = formatUnknown(usageRows[index]?.[field] ?? "unassigned");
			totals.set(label, (totals.get(label) ?? 0) + session.spend);
		}
		return [...totals.entries()]
			.map(([label, spend]) => ({
				id: label,
				label,
				spend,
				share: totalSpend > 0 ? Math.round((spend / totalSpend) * 100) : 0,
			}))
			.toSorted((left, right) => right.spend - left.spend);
	};
	const dailyTotals = new Map<string, number>();
	for (const session of liveSessions) {
		const date = new Date(session.started);
		const day = Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
		dailyTotals.set(day, (dailyTotals.get(day) ?? 0) + session.spend);
	}
	const liveDaily: DailyCost[] = [...dailyTotals.entries()]
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([day, spend]) => ({ day: dayLabel(day), spend, prior: 0 }));
	const governanceByAgent = new Map((governance?.items ?? []).map((item) => [item.agent, item]));
	const liveAgents: AgentCost[] = makeBreakdown("agent").flatMap((row) => {
		const agentGovernance = governanceByAgent.get(row.label);
		if (!agentGovernance) return [];
		const agentSessions = liveSessions.filter((session) => session.agent === row.label);
		const agentSpend = agentSessions.reduce((sum, session) => sum + session.spend, 0);
		const modelSpend = new Map<string, number>();
		for (const session of agentSessions)
			modelSpend.set(session.model, (modelSpend.get(session.model) ?? 0) + session.spend);
		return [
			{
				handle: row.label,
				host: "usage ledger",
				spend: row.spend ?? 0,
				tokens: `${agentSessions.reduce((sum, session) => sum + number(session.tokens.replace("M total", "")), 0).toFixed(2)}M total`,
				mix: [...modelSpend.entries()].map(([label, spend]) => ({
					label,
					share: agentSpend > 0 ? Math.round((spend / agentSpend) * 100) : 0,
				})),
				spark: [],
				governance: agentGovernance,
			},
		];
	});

	return {
		ledgerAvailable: usage !== null && usage.truncated !== true && priceBook !== null,
		governanceAvailable: governance !== null,
		controlPlaneLive: (executors?.items ?? []).some(
			(item) => item.kind === "control-plane" && item.liveness === "alive",
		),
		isMock: false,
		range,
		ledgerWindow,
		observedAt: usage?.freshness.observed_at ?? governance?.freshness.observed_at ?? null,
		governance: governance?.items ?? [],
		pool: governance?.pool ?? null,
		daily: liveDaily,
		breakdowns: {
			agent: makeBreakdown("agent"),
			model: makeBreakdown("model"),
			project: makeBreakdown("project"),
		},
		agents: liveAgents,
		sessions: liveSessions,
		prices: livePrices,
		summary: { spend: totalSpend, tokens: totalTokens, queryRef: usage?.query_ref ?? null },
		pricingQueryRef: priceBook?.query_ref ?? null,
		lanes: shell.me.lanes,
	};
};
