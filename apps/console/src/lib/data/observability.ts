import type { CatalogEntry, DashboardItem, QueryResult } from "$lib/api/types";

export interface AccountingData {
	queries: Record<"events" | "freshness" | "queries" | "emitters", QueryResult | null>;
	catalog: CatalogEntry[];
	dashboards: DashboardItem[];
	errors: string[];
	isMock: boolean;
	lanes: string[];
	executors: { consoleApi: boolean; library: boolean };
}

const now = new Date().toISOString();
const fixtureResult = (
	columns: [string, "string" | "number" | "timestamp"][],
	rows: unknown[][],
	ref: string,
): QueryResult => ({
	schema_version: 1,
	columns: columns.map(([name, type]) => ({ name, type })),
	rows,
	row_count: rows.length,
	execution_ms: 18,
	freshness: { source: "mock fixture", observed_at: now, window_s: null },
	query_ref: ref,
});

export function mockAccounting(lanes: string[]): AccountingData {
	return {
		queries: {
			events: fixtureResult(
				[
					["minute", "timestamp"],
					["events", "number"],
				],
				[
					["-5m", 78],
					["-4m", 84],
					["-3m", 76],
					["-2m", 92],
					["-1m", 88],
					["now", 101],
				],
				"qry_bus_events",
			),
			freshness: fixtureResult([["newest", "timestamp"]], [[now]], "qry_lake_freshness"),
			queries: fixtureResult(
				[
					["runs", "number"],
					["refused", "number"],
				],
				[[127, 3]],
				"qry_queries_today",
			),
			emitters: fixtureResult(
				[
					["scope", "string"],
					["events", "number"],
					["share", "number"],
				],
				[
					["lab.fleet.*", 41208, 46],
					["host.*", 22114, 25],
					["home.ha.*", 14551, 16],
				],
				"qry_top_emitters",
			),
		},
		catalog: [
			"lab.fleet.tokens_spent",
			"lab.bus.events",
			"host.mc34.mem.used",
			"host.12.disk.used",
			"home.ha.power.house",
			"unifi.ap.clients",
			"proxmox.vm.migrations",
			"health.parker.sleep.hours",
			"health.parker.hr.resting",
		].map((type, i) => ({
			type,
			first_seen: now,
			last_emit:
				i === 6
					? new Date(Date.now() - 259200000).toISOString()
					: new Date(Date.now() - i * 4000).toISOString(),
			scopes: ["lab"],
			dimensions: {},
			measures: { value: { kind: i === 1 || i === 6 ? "counter" : "gauge" } },
			emit_rate_per_min: i === 6 ? 0.01 : 1,
		})),
		dashboards: [
			{
				id: "d1",
				title: "Morning sweep",
				is_home: true,
				kind: "artifact",
				created_by: "parker",
				updated_at: now,
				panel_count: 9,
				scope: "lab",
			},
			{
				id: "d2",
				title: "Token burn, fleet",
				is_home: false,
				kind: "artifact",
				created_by: "janet",
				updated_at: now,
				panel_count: 4,
				scope: "lab",
			},
			{
				id: "d3",
				title: "Sleep vs deploys",
				is_home: false,
				kind: "artifact",
				created_by: "parker",
				updated_at: now,
				panel_count: 6,
				scope: "health.parker",
			},
		],
		errors: [],
		isMock: true,
		lanes,
		executors: { consoleApi: true, library: true },
	};
}

export function emptyAccounting(errors: string[], lanes: string[]): AccountingData {
	return {
		queries: { events: null, freshness: null, queries: null, emitters: null },
		catalog: [],
		dashboards: [],
		errors,
		isMock: false,
		lanes,
		executors: { consoleApi: false, library: false },
	};
}

export function isStale(result: QueryResult | null, nowMs: number): boolean {
	return Boolean(
		result?.freshness.window_s != null &&
		nowMs - Date.parse(result.freshness.observed_at) > result.freshness.window_s * 1000,
	);
}

export function lagSeconds(result: QueryResult | null, nowMs: number): number | null {
	const newest = result?.rows[0]?.[0];
	if (typeof newest !== "string") return null;
	const timestamp = Date.parse(newest);
	return Number.isFinite(timestamp) ? Math.max(0, Math.round((nowMs - timestamp) / 1000)) : null;
}
