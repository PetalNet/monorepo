// Tracker reads (N1b-2, PHASE1B-DESIGN §4). The tracker (tasks app) is a single-writer SQLite
// store with its OWN ACL (owner / visibility shared|private / project). Lake RLS cannot reach it,
// so console-api reads it READ-ONLY and maps each row's native visibility to a console scope tag,
// then filters by the CALLER's resolved scopes (Rule 11). The single-writer rule is intact — reads
// never write; the tasks app remains the sole writer. `/leases` is projected through leasePublic.
//
// Coupling note: this reads the tracker's SQLite file directly (node:sqlite, zero native deps).
// The cleaner long-term seam is a scoped HTTP `list` op on the tracker RPC (it has none today); a
// read-only file read + console-side scope mapping is the pragmatic, authz-correct path for now.

import { DatabaseSync } from "node:sqlite";

/** Map a tracker row's native visibility to the console scope tag that governs who may read it. */
function trackerScope(row: {
	project_name?: string | null;
	visibility?: string | null;
	owner?: string | null;
}): string {
	if (row.project_name) return `project:${row.project_name}`;
	if (row.visibility === "private" && row.owner) return `user:${row.owner}`;
	return "fleet";
}

/** Keep only rows whose mapped scope is in the caller's grant set. */
export function filterByScopes<
	T extends { project_name?: string | null; visibility?: string | null; owner?: string | null },
>(rows: readonly T[], scopes: readonly string[]): T[] {
	const grant = new Set(scopes);
	return rows.filter((r) => grant.has(trackerScope(r)));
}

const LEASE_SECRET_KEYS = new Set(["claim_token", "claimtoken", "token", "secret"]);

/** LeasePublic projection: strip claim_token and any lease secret before a lease row leaves. */
function leasePublic<T extends Record<string, unknown>>(row: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		if (!LEASE_SECRET_KEYS.has(k.toLowerCase())) out[k] = v;
	}
	return out as Partial<T>;
}

export interface TrackerRow {
	project_name?: string | null;
	visibility?: string | null;
	owner?: string | null;
	[k: string]: unknown;
}

/** Read-only tracker access over node:sqlite. Never writes — the tasks app is the sole writer. */
export class TrackerReader {
	readonly #db: DatabaseSync;

	constructor(dbPath: string) {
		this.#db = new DatabaseSync(dbPath, { readOnly: true });
	}

	close(): void {
		this.#db.close();
	}

	#all(sql: string): TrackerRow[] {
		return this.#db.prepare(sql).all() as TrackerRow[];
	}

	/** Active + recent tasks, mapped to console scope. claim_token is never selected. */
	tasks(limit = 500): TrackerRow[] {
		return this.#all(
			`select t.id, t.kind, t.title, t.status, t.priority, t.assignee, t.claimed_by, t.owner,
				t.visibility, t.project_id, t.blocked_on, t.verification_status, t.up_next, t.rank,
				t.parent_id, t.effort, t.suggested_agent, t.close_reason, t.updated_at, p.name as project_name
			from tasks t left join projects p on p.id = t.project_id
			order by t.updated_at desc limit ${String(Math.min(Math.max(1, Math.floor(limit)), 2000))}`,
		);
	}

	/** LeasePublic view of held leases (status=doing). claim_token is NOT selected. */
	leases(): TrackerRow[] {
		const rows = this.#all(
			`select t.id as task_id, t.claimed_by as worker, t.lease_expires_at, t.owner, t.visibility,
				p.name as project_name
			from tasks t left join projects p on p.id = t.project_id
			where t.status = 'doing' and coalesce(t.claimed_by,'') != ''`,
		);
		return rows.map((r) => leasePublic(r) as TrackerRow);
	}

	/** Agent identities (fleet-scoped operational roster). */
	agents(): TrackerRow[] {
		return this.#all(
			`select handle, display_name, host, role, lane, capabilities, autonomy, active from agents`,
		).map((r) => ({ ...r, visibility: "shared" as const })); // agents are fleet-visible
	}
}
