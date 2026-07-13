import { dataMode, readCatalog, readDashboards, readExecutors, runQuery } from "$lib/api/client";
import type { CatalogEntry, DashboardItem, QueryResult, StructuredQuery } from "$lib/api/types";
import { emptyAccounting, mockAccounting } from "$lib/data/observability";

import type { PageLoad } from "./$types";

const queries: Record<string, StructuredQuery> = {
	events: {
		schema_version: 1,
		mode: "structured",
		from: "events",
		select: [{ field: "seq", agg: "count", as: "events" }],
		time: { from: "-6m", bucket: "1m", fill: "null", coverage: false },
		order: [{ field: "bucket", dir: "asc" }],
		limit: 8,
	},
	freshness: {
		schema_version: 1,
		mode: "structured",
		from: "events",
		select: [{ field: "received_at", agg: "last", as: "newest" }],
		limit: 1,
	},
	queries: {
		schema_version: 1,
		mode: "structured",
		from: "events",
		select: [{ field: "seq", agg: "count", as: "runs" }],
		where: { type: "stats.query" },
		time: { from: "-24h" },
		limit: 1,
	},
	emitters: {
		schema_version: 1,
		mode: "structured",
		from: "events",
		select: [{ field: "scope" }, { field: "seq", agg: "count", as: "events" }],
		group_by: ["scope"],
		time: { from: "-24h" },
		order: [{ field: "events", dir: "desc" }],
		limit: 12,
	},
};

export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (dataMode() === "mock") return { accounting: mockAccounting(shell.me.lanes) };
	const errors: string[] = [];
	const entries = await Promise.all(
		Object.entries(queries).map(async ([key, q]) => {
			try {
				return [key, await runQuery(q, fetch)] as const;
			} catch {
				errors.push(`${key} query unavailable`);
				return [key, null] as const;
			}
		}),
	);
	let catalog: CatalogEntry[] = [];
	let dashboards: DashboardItem[] = [];
	try {
		catalog = (await readCatalog(fetch)).items;
	} catch {
		errors.push("catalog unavailable");
	}
	try {
		dashboards = (await readDashboards(fetch)).items;
	} catch {
		errors.push("saved dashboards unavailable");
	}
	const accounting = emptyAccounting(errors, shell.me.lanes);
	accounting.queries = Object.fromEntries(entries) as Record<
		"events" | "freshness" | "queries" | "emitters",
		QueryResult | null
	>;
	accounting.catalog = catalog;
	accounting.dashboards = dashboards;
	try {
		const executors = (await readExecutors(fetch)).items;
		accounting.executors = {
			consoleApi: executors.some((e) => e.kind === "console-api" && e.liveness === "alive"),
			library: executors.some((e) => e.kind === "library" && e.liveness === "alive"),
		};
	} catch {
		errors.push("executor liveness unavailable");
	}
	return { accounting };
};
