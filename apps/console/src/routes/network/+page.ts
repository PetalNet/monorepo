import type { QueryResult } from "$lib/api/types";
import { mockEdgeHealth, mockSessions, mockWireEvents } from "$lib/data/network";
import { captureCaughtFailure } from "$lib/glitchtip";
import { dataMode, readEdgeSessions, readExecutors, runQuery } from "$lib/rpc/browser";

import type { PageLoad } from "./$types";

function queryRecords(result: QueryResult): Record<string, unknown>[] {
	return result.rows.map((row) =>
		Object.fromEntries(result.columns.map((column, index) => [column.name, row[index]])),
	);
}

export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (dataMode() === "mock") {
		return {
			sessions: mockSessions,
			sessionsAvailable: true,
			health: mockEdgeHealth,
			wire: mockWireEvents,
			observedAt: mockEdgeHealth.updatedAt,
			lanes: shell.me.lanes,
			edgeLive: true,
			managerLive: true,
			controlPlaneLive: true,
			error: null,
		};
	}
	const executors = await readExecutors(fetch).catch((error) => {
		captureCaughtFailure(error, { surface: "network", endpoint: "/executors" });
		return null;
	});
	const alive = (kind: string) =>
		(executors?.items ?? []).some((item) => item.kind === kind && item.liveness === "alive");
	const doormanHistory = await runQuery(
		{
			schema_version: 1,
			mode: "structured",
			from: "events",
			select: [{ field: "type" }, { field: "subject" }, { field: "source.agent" }, { field: "ts" }],
			where: { type: { op: "like", value: "doorman.%" } },
			time: { from: new Date(Date.now() - 86_400_000).toISOString() },
			order: [{ field: "ts", dir: "desc" }],
			limit: 100,
		},
		fetch,
	).catch(() => null);
	const edgeHealth = await runQuery(
		{
			schema_version: 1,
			mode: "structured",
			from: "doorman.health",
			select: [{ field: "state" }, { field: "listener" }, { field: "caddy_ok" }, { field: "ts" }],
			order: [{ field: "ts", dir: "desc" }],
			limit: 1,
		},
		fetch,
	).catch(() => null);
	const history = doormanHistory ? queryRecords(doormanHistory) : [];
	const edgeEvidence = edgeHealth ? queryRecords(edgeHealth)[0] : null;
	const edgeObservedAt = typeof edgeEvidence?.["ts"] === "string" ? edgeEvidence["ts"] : null;
	const newerStatus = history.find(
		(event) =>
			["doorman.dark", "doorman.degrade", "doorman.recover"].includes(String(event["type"])) &&
			typeof event["ts"] === "string" &&
			(!edgeObservedAt || Date.parse(event["ts"]) > Date.parse(edgeObservedAt)),
	);
	const newestEvidenceAt =
		typeof newerStatus?.["ts"] === "string" ? newerStatus["ts"] : edgeObservedAt;
	const newestEvidenceAgeMs = newestEvidenceAt
		? Date.now() - Date.parse(newestEvidenceAt)
		: Number.POSITIVE_INFINITY;
	const newestEvidenceType = String(newerStatus?.["type"] ?? "doorman.health");
	const reportedState = edgeEvidence?.["state"];
	const health =
		edgeEvidence &&
		edgeObservedAt &&
		["open", "degraded", "dark"].includes(String(reportedState)) &&
		typeof edgeEvidence["listener"] === "string" &&
		typeof edgeEvidence["caddy_ok"] === "boolean"
			? {
					state:
						newestEvidenceAgeMs > 90_000 || newestEvidenceType === "doorman.dark"
							? ("dark" as const)
							: newestEvidenceAgeMs > 30_000 || newestEvidenceType === "doorman.degrade"
								? ("degraded" as const)
								: newestEvidenceType === "doorman.recover"
									? ("open" as const)
									: (reportedState as "open" | "degraded" | "dark"),
					listener: edgeEvidence["listener"],
					caddyOk:
						newestEvidenceAgeMs <= 30_000 &&
						(newestEvidenceType === "doorman.recover" || edgeEvidence["caddy_ok"]),
					updatedAt: newestEvidenceAt ?? (edgeObservedAt as string),
				}
			: null;
	const wire = history
		.filter((event) =>
			/^(doorman\.(link\.flap|session\.resume|degrade|recover|auth\.failure))$/.test(
				String(event["type"]),
			),
		)
		.slice(0, 6)
		.map((event) => ({
			type: String(event["type"]).replace(/^doorman\./, ""),
			handle: String(event["source_agent"] ?? event["subject"] ?? "unknown"),
			detail: String(event["subject"] ?? "event persisted"),
			at: String(event["ts"]),
		}));
	try {
		const response = await readEdgeSessions(fetch);
		return {
			sessions: response.items,
			sessionsAvailable: true,
			health,
			wire,
			observedAt: response.freshness.observed_at,
			lanes: shell.me.lanes,
			edgeLive: alive("edge"),
			managerLive: alive("manager"),
			controlPlaneLive: alive("control-plane"),
			error: null,
		};
	} catch (error) {
		captureCaughtFailure(error, { surface: "network", endpoint: "/edge/sessions" });
		return {
			sessions: [],
			sessionsAvailable: false,
			health,
			wire,
			observedAt: null,
			lanes: shell.me.lanes,
			edgeLive: alive("edge"),
			managerLive: alive("manager"),
			controlPlaneLive: alive("control-plane"),
			error: "Session projection unavailable",
		};
	}
};
