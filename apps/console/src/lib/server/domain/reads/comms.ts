import { Effect } from "effect";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import type { ReadEnvelope } from "./entities.ts";

export type CommsType = "task-card" | "rpc" | "mail";

export interface CommsReadOpts {
	readonly type?: CommsType;
	readonly agent?: string;
	readonly taskId?: number;
	readonly limit?: number;
	readonly cursor?: string;
}

export function decodeCommsCursor(cursor: string): string | null {
	try {
		const decoded = Buffer.from(cursor, "base64url").toString("utf8");
		return /^[1-9]\d*$/.test(decoded) && Buffer.from(decoded).toString("base64url") === cursor
			? decoded
			: null;
	} catch {
		return null;
	}
}

function encodeCommsCursor(seq: string): string {
	return Buffer.from(seq).toString("base64url");
}

interface CommsRow {
	readonly seq: string;
	readonly id: string;
	readonly method: "comms.card" | "comms.rpc" | "comms.mail";
	readonly sender: string;
	readonly recipient: string;
	readonly task_id: string | number | null;
	readonly in_reply_to: string | null;
	readonly ts: string | Date;
	readonly card_id: string | null;
	readonly about: string | null;
	readonly body_preview: string | null;
}

/**
 * Persisted, RLS-scoped correspondence history ordered newest first.
 *
 * An Effect: the scoped lake query is the one external edge (`Effect.promise` over the pg
 * transaction) and the paging/projection is a pure function mapped over the rows. A malformed
 * cursor is not a failure — it is decoded to `null` and simply drops the seek predicate — and a
 * lake fault is a defect, so the error channel is empty and the read composes straight into the
 * remote and HTTP planes.
 */
export function readCommsLog(
	app: Sql,
	scopes: readonly string[],
	opts: CommsReadOpts = {},
): Effect.Effect<ReadEnvelope> {
	const requestedLimit = opts.limit ?? 200;
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(1, Math.floor(requestedLimit)), 1000)
		: 200;
	const eventType = opts.type
		? ({ "task-card": "comms.card", rpc: "comms.rpc", mail: "comms.mail" } as const)[opts.type]
		: null;
	const agent = opts.agent?.trim().toLocaleLowerCase() || null;
	const taskId = opts.taskId ?? null;
	const cursor = opts.cursor ? decodeCommsCursor(opts.cursor) : null;

	return Effect.map(
		Effect.promise(() =>
			withScopes(
				app,
				scopes,
				async (tx) =>
					tx<CommsRow[]>`
					select e.seq::text as seq, e.id::text as id, e.type as method,
						e.source_agent as sender,
						e.subject as recipient,
						e.task_id,
						nullif(e.dimensions->>'in_reply_to', '') as in_reply_to,
						e.ts,
						nullif(e.dimensions->>'card_id', '') as card_id,
						nullif(e.dimensions->>'method', '') as about,
						coalesce(
							case when b.id is null then null else left(convert_from(b.bytes, 'UTF8'), 240) end,
							left(nullif(e.meta->>'body_preview', ''), 240)
						)
							as body_preview
					from lake_events e
					left join blobs b on b.id = e.body_ref and b.scope = e.scope
					where e.type in ('comms.card', 'comms.rpc', 'comms.mail')
					  and nullif(e.source_agent, '') is not null
					  and nullif(e.subject, '') is not null
					  and (${eventType}::text is null or e.type = ${eventType})
					  and (${taskId}::bigint is null or e.task_id = ${taskId})
					  and (${cursor}::bigint is null or e.seq < ${cursor})
					  and (${agent}::text is null
						or lower(e.source_agent) = ${agent}
						or lower(e.subject) = ${agent})
					order by e.seq desc
					limit ${limit + 1}`,
			),
		),
		(rows) => {
			const truncated = rows.length > limit;
			const page = truncated ? rows.slice(0, limit) : rows;
			const newestValue = page[0]?.ts;
			const newest = newestValue
				? typeof newestValue === "string"
					? newestValue
					: newestValue.toISOString()
				: "1970-01-01T00:00:00Z";
			return {
				schema_version: 1,
				freshness: { source: "lake", observed_at: newest, window_s: null },
				items: page.map(({ seq: _seq, ts, task_id, ...row }) => ({
					...row,
					task_id: task_id === null ? null : Number(task_id),
					ts: typeof ts === "string" ? ts : ts.toISOString(),
				})),
				next_cursor: truncated && page.at(-1) ? encodeCommsCursor(page.at(-1)?.seq ?? "") : null,
				truncated,
			};
		},
	);
}
