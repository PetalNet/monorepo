import { Effect } from "effect";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";

export interface UpdateApprovalOptions {
	readonly limit?: number;
	readonly cursor?: string | null;
	readonly since?: string | null;
}

export function readUpdateApprovals(
	app: Sql,
	scopes: readonly string[],
	boxId: string,
	opts: UpdateApprovalOptions = {},
): Effect.Effect<Record<string, unknown>> {
	const limit = opts.limit ?? 200;
	const cursor = opts.cursor ?? null;
	const since = opts.since ?? null;
	return Effect.map(
		Effect.promise(() =>
			withScopes(
				app,
				scopes,
				async (tx) =>
					tx<
						{
							approval_id: string;
							box_id: string;
							packages: string[];
							approved_by: string;
							approved_at: string;
							revocable: boolean;
							observed_at: string;
						}[]
					>`
					select approved.dimensions->>'approval_id' as approval_id,
					       approved.subject as box_id,
					       coalesce(approved.meta->'packages', '[]'::jsonb) as packages,
					       approved.dimensions->>'approved_by' as approved_by,
					       approved.ts::text as approved_at,
					       true as revocable,
					       approved.received_at::text as observed_at
					from lake_events approved
					where approved.type = 'updates.approved'
					  and approved.subject = ${boxId}
					  and (${since}::timestamptz is null or approved.received_at >= ${since}::timestamptz)
					  and (${cursor}::uuid is null or approved.seq < coalesce((
					    select cursor_event.seq from lake_events cursor_event
					    where cursor_event.type = 'updates.approved'
					      and cursor_event.dimensions->>'approval_id' = ${cursor}
					    limit 1
					  ), 0))
					  and not exists (
					    select 1 from lake_events later
					    where (
					      later.type in ('updates.approval_revoked', 'updates.applied')
					      and later.dimensions->>'approval_id' = approved.dimensions->>'approval_id'
					    ) or (
					      later.seq > approved.seq and (
					        (later.type = 'audit.op.outcome'
					          and later.dimensions->>'op' = 'updates.apply'
					          and later.dimensions->>'outcome' = 'ok'
					          and later.dimensions->>'box_id' = approved.subject)
					        or (later.type = 'box.update_status_changed'
					          and later.subject = approved.subject
					          and (later.dimensions->>'status' = 'up_to_date' or (
					            jsonb_typeof(later.meta->'box_update_raw'->'packages') = 'array'
					            and exists (
					            select 1 from jsonb_array_elements_text(approved.meta->'packages') as approved_package(name)
					              where not exists (
					                select 1 from jsonb_array_elements(later.meta->'box_update_raw'->'packages') pending
					              where pending->>'name' = approved_package.name
					              )
					            )
					          )))
					      )
					    )
					  )
					order by approved.seq desc limit ${limit + 1}`,
			),
		),
		(items) => {
			const rowTruncated = items.length > limit;
			const candidates = (rowTruncated ? items.slice(0, limit) : items).map((item) => ({
				...item,
				approved_at: new Date(item.approved_at).toISOString(),
				observed_at: new Date(item.observed_at).toISOString(),
			}));
			const page: typeof candidates = [];
			let serializedBytes = 512;
			for (const item of candidates) {
				const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
				if (page.length > 0 && serializedBytes + itemBytes > 1_000_000) break;
				page.push(item);
				serializedBytes += itemBytes;
			}
			const truncated = rowTruncated || page.length < candidates.length;
			return {
				schema_version: 1,
				freshness: {
					source: "updates approval ledger",
					observed_at: page.reduce(
						(newest, item) => (item.observed_at > newest ? item.observed_at : newest),
						"1970-01-01T00:00:00Z",
					),
					window_s: null,
				},
				items: page,
				next_cursor: truncated ? (page.at(-1)?.approval_id ?? null) : null,
				truncated,
			};
		},
	);
}
