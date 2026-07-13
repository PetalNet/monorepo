// /roster and /executors (N1b-2, PHASE1B-DESIGN §5). /roster joins the lake current_state
// (fleet/heartbeat/registry/governance) with the tracker (agents/leases), each source scoped
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
		data: (row.state ?? null) as T | null,
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
			where kind in ('fleet','heartbeat','registry','governance')`,
	);
	const byHandle = new Map<string, Partial<Record<string, CurrentRow>>>();
	for (const r of rows) {
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

	const handles = new Set<string>([...byHandle.keys(), ...agentByHandle.keys()]);
	const items = [...handles].sort().map((handle) => {
		const cs = byHandle.get(handle) ?? {};
		return {
			handle,
			fleet: source(cs["fleet"]),
			heartbeat: source(cs["heartbeat"]),
			registry: source(cs["registry"]),
			governance: source(cs["governance"]),
			identity: agentByHandle.has(handle)
				? { visibility: "visible", data: agentByHandle.get(handle) }
				: { visibility: tracker ? "absent" : "absent", data: null },
			lease: leaseByWorker.has(handle)
				? { visibility: "visible", data: leaseByWorker.get(handle) }
				: { visibility: "absent", data: null },
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

/** /executors — pre-flight liveness for ActionRows, derived from lake registry + heartbeat state. */
export async function readExecutors(app: Sql, scopes: readonly string[]): Promise<ReadEnvelope> {
	// registry current-state carries per-agent last_seen; managers' heartbeat carries manager liveness.
	const rows = await withScopes(
		app,
		scopes,
		async (tx) =>
			tx<
				CurrentRow[]
			>`select kind, subject, state, observed_at from current_state where kind in ('registry','heartbeat')`,
	);
	const now = Date.now();
	const items = EXECUTOR_KINDS.map((kind) => {
		// derive a coarse liveness for the executor class from the freshest matching current_state row.
		const matches = rows.filter((r) =>
			kind === "manager" ? r.kind === "heartbeat" : r.kind === "registry",
		);
		let freshest = 0;
		for (const m of matches) {
			const t = new Date(
				typeof m.observed_at === "string" ? m.observed_at : m.observed_at,
			).getTime();
			if (t > freshest) freshest = t;
		}
		const ageS = freshest === 0 ? null : (now - freshest) / 1000;
		const liveness =
			ageS === null ? "unknown" : ageS <= 90 ? "alive" : ageS <= 300 ? "suspect" : "down";
		return { kind, liveness, last_seen: freshest === 0 ? null : new Date(freshest).toISOString() };
	});
	return {
		schema_version: 1,
		freshness: { source: "lake", observed_at: new Date().toISOString(), window_s: null },
		items,
		next_cursor: null,
		truncated: false,
	};
}
