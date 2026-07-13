// Typed entity reads over the current_state projection (N1b, contract §3.3). RLS filters every row
// to the caller's scopes (withScopes). Per-item observed_at is served raw — the consumer computes
// staleness against the §8 windows; the read never pre-derives `offline`.

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import type { ProjectionKind } from "../projector/index.ts";

export interface ReadEnvelope {
	schema_version: 1;
	freshness: { source: string; observed_at: string; window_s: number | null };
	items: Record<string, unknown>[];
	next_cursor: string | null;
	truncated: boolean;
}

interface StateRow {
	subject: string;
	state: Record<string, unknown>;
	observed_at: string;
	unreachable_since: string | null;
	seq: string;
}

export interface ReadOpts {
	limit?: number | undefined;
	cursor?: string | undefined;
}

/** Read the latest state for every entity of `kind` the caller can see, newest-subject paginated. */
export async function readEntity(
	app: Sql,
	scopes: readonly string[],
	kind: ProjectionKind,
	opts: ReadOpts = {},
): Promise<ReadEnvelope> {
	const limit = Math.min(Math.max(1, Math.floor(Number(opts.limit ?? 200))), 1000);
	const after = opts.cursor ?? "";
	const rows = await withScopes(
		app,
		scopes,
		async (tx) =>
			tx<StateRow[]>`
			select subject, state, observed_at, unreachable_since, seq
			from current_state
			where kind = ${kind} and subject > ${after}
			order by subject asc limit ${limit + 1}`,
	);
	const truncated = rows.length > limit;
	const page = truncated ? rows.slice(0, limit) : rows;
	let newest = "1970-01-01T00:00:00Z";
	const items = page.map((r) => {
		const obs =
			typeof r.observed_at === "string" ? r.observed_at : new Date(r.observed_at).toISOString();
		if (obs > newest) newest = obs;
		return {
			...r.state,
			subject: r.subject,
			observed_at: obs,
			unreachable_since:
				r.unreachable_since === null
					? null
					: typeof r.unreachable_since === "string"
						? r.unreachable_since
						: new Date(r.unreachable_since).toISOString(),
		};
	});
	return {
		schema_version: 1,
		freshness: { source: "lake", observed_at: newest, window_s: null },
		items,
		next_cursor: truncated ? (page[page.length - 1]?.subject ?? null) : null,
		truncated,
	};
}
