// /roster and /executors (N1b-2). /roster joins the lake current_state
// (fleet/heartbeat/registry/governance/workers) with the tracker (agents/leases), each source scoped
// BEFORE association. A per-source `visibility` marker distinguishes "no row" from "not yours" so
// the frontend never renders authz-denied as "no data" (Rule 10). It is a mixed-source join, not
// an atomic snapshot — each source carries its own observed_at.

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import type { ReadEnvelope } from "./entities.ts";
import { filterByScopes, type TrackerReader } from "./tracker.ts";

interface CurrentRow {
	kind: string;
	subject: string;
	state: Record<string, unknown>;
	observed_at: string;
}

interface SourceView<T> {
	visibility: "visible" | "absent";
	observed_at: string | null;
	data: T | null;
}

function source<T>(row: { state?: T; observed_at?: string } | undefined): SourceView<T> {
	if (!row) return { visibility: "absent", observed_at: null, data: null };
	return {
		visibility: "visible",
		observed_at: row.observed_at ?? null,
		data: row.state ?? null,
	};
}

export async function readRoster(
	app: Sql,
	tracker: TrackerReader | null,
	scopes: readonly string[],
): Promise<ReadEnvelope> {
	// lake current_state for the aggregate agent kinds, RLS-scoped as-caller.
	const rows = await withScopes(
		app,
		scopes,
		async (tx) =>
			tx<CurrentRow[]>`
			select kind, subject, state, observed_at from current_state
			where kind in ('fleet','heartbeat','registry','governance','worker')`,
	);
	const byHandle = new Map<string, Partial<Record<string, CurrentRow>>>();
	const workersByHandle = new Map<string, number>();
	for (const r of rows) {
		if (r.kind === "worker") {
			const owner = r.state["handle"];
			if (typeof owner === "string")
				workersByHandle.set(owner, (workersByHandle.get(owner) ?? 0) + 1);
			continue;
		}
		const obs =
			typeof r.observed_at === "string" ? r.observed_at : new Date(r.observed_at).toISOString();
		const entry = byHandle.get(r.subject) ?? {};
		entry[r.kind] = { ...r, observed_at: obs };
		byHandle.set(r.subject, entry);
	}
	// tracker halves (agents identity + active leases), scoped by the visibility→scope mapping.
	const agents = tracker ? filterByScopes(tracker.agents(), scopes) : [];
	const leases = tracker ? filterByScopes(tracker.leases(), scopes) : [];
	const agentByHandle = new Map(agents.map((a) => [String(a["handle"]), a]));
	const leaseByWorker = new Map(leases.map((l) => [String(l["worker"]), l]));

	// union lake handles + agent identities + lease WORKERS (a worker may hold a lease with no lake
	// row and no agents entry — it must still appear on the roster; codex N1b-2 re-review P1).
	const handles = new Set<string>([
		...byHandle.keys(),
		...workersByHandle.keys(),
		...agentByHandle.keys(),
		...leaseByWorker.keys(),
	]);
	const items = [...handles].toSorted().map((handle) => {
		const cs = byHandle.get(handle) ?? {};
		return {
			handle,
			workers_active: workersByHandle.get(handle) ?? 0,
			fleet: source(cs["fleet"]),
			heartbeat: source(cs["heartbeat"]),
			registry: source(cs["registry"]),
			governance: source(cs["governance"]),
			// tracker null => "unavailable" (source down), distinct from "absent" (no row) — the frontend
			// must not render an unavailable source as "no data" (codex N1b-2 P1, Rule 10).
			identity: !tracker
				? { visibility: "unavailable" as const, data: null }
				: agentByHandle.has(handle)
					? { visibility: "visible" as const, data: agentByHandle.get(handle) }
					: { visibility: "absent" as const, data: null },
			lease: !tracker
				? { visibility: "unavailable" as const, data: null }
				: leaseByWorker.has(handle)
					? { visibility: "visible" as const, data: leaseByWorker.get(handle) }
					: { visibility: "absent" as const, data: null },
		};
	});
	return {
		schema_version: 1,
		freshness: {
			source: "roster(lake+tracker)",
			observed_at: new Date().toISOString(),
			window_s: null,
		},
		items,
		next_cursor: null,
		truncated: false,
	};
}

// The executor kinds whose liveness gates ActionRows (contract §5.1 / entities/executor.schema.json).
const EXECUTOR_KINDS = [
	"manager",
	"dispatcher",
	"control-plane",
	"tracker",
	"library",
	"box-agent",
	"edge",
	"probe-runner",
	"pty",
	"console-api",
] as const;

function livenessFrom(
	observedAt: string | undefined,
	now: number,
): { liveness: string; last_seen: string | null } {
	if (!observedAt) return { liveness: "unknown", last_seen: null };
	const t = new Date(observedAt).getTime();
	const ageS = (now - t) / 1000;
	return {
		liveness: ageS <= 90 ? "alive" : ageS <= 300 ? "suspect" : "down",
		last_seen: new Date(t).toISOString(),
	};
}

/**
 * /executors — per-instance ActionRow pre-flight liveness. Reports ONLY liveness we have real lake
 * evidence for (codex N1b-2 P1): managers from their heartbeat rows (per handle). The remaining
 * executor SERVICES (dispatcher/control-plane/tracker/library/box-agent/edge/…) have no lake
 * liveness source until their emitters land in N1c — reported `unknown`, never faked `alive` from
 * an unrelated agent registry row.
 */
export async function readExecutors(app: Sql, scopes: readonly string[]): Promise<ReadEnvelope> {
	const rows = await withScopes(
		app,
		scopes,
		async (tx) =>
			tx<
				CurrentRow[]
			>`select kind, subject, observed_at from current_state where kind = 'heartbeat'`,
	);
	const now = Date.now();
	const items: { kind: string; ref: string | null; liveness: string; last_seen: string | null }[] =
		[];
	// per-manager instances from heartbeat rows (the real evidence we have)
	for (const r of rows) {
		const obs =
			typeof r.observed_at === "string" ? r.observed_at : new Date(r.observed_at).toISOString();
		items.push({ kind: "manager", ref: r.subject, ...livenessFrom(obs, now) });
	}
	// the other executor kinds: no lake evidence yet (N1c emitters) — honest `unknown`.
	for (const kind of EXECUTOR_KINDS) {
		if (kind === "manager") continue;
		items.push({ kind, ref: null, liveness: "unknown", last_seen: null });
	}
	return {
		schema_version: 1,
		freshness: { source: "lake", observed_at: new Date().toISOString(), window_s: null },
		items,
		next_cursor: null,
		truncated: false,
	};
}
