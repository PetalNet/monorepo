// Typed entity reads over the current_state projection (N1b, contract §3.3). RLS filters every row
// to the caller's scopes (withScopes). Per-item observed_at is served raw — the consumer computes
// staleness against the §8 windows; the read never pre-derives `offline`.
//
// Every read is an Effect: the scoped query is the one external edge (`Effect.promise` over the pg
// transaction) and the projection is a pure function mapped over the rows. A lake fault is a defect,
// so the error channel is empty and the reads compose straight into the remote and HTTP planes.

import { Effect } from "effect";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import type { ProjectionKind } from "../projector/index.ts";

export interface ReadEnvelope<Item = Record<string, unknown>> {
	schema_version: 1;
	freshness: { source: string; observed_at: string; window_s: number | null };
	items: Item[];
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
	since?: string | undefined;
	state?: string | undefined;
	handle?: string | undefined;
	owner?: string | undefined;
	requiredFields?: readonly string[] | undefined;
}

type EntityMapper = (row: StateRow) => Record<string, unknown> | null;

function readProjectedEntity(
	app: Sql,
	scopes: readonly string[],
	kind: ProjectionKind,
	opts: ReadOpts,
	map: EntityMapper,
): Effect.Effect<ReadEnvelope> {
	const n = opts.limit ?? 200;
	const limit = Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 1000) : 200;
	const after = opts.cursor ?? "";
	const since = opts.since ?? null;
	const state = opts.state ?? null;
	const handle = opts.handle ?? null;
	const owner = opts.owner ?? null;
	const requiredFields = [...(opts.requiredFields ?? [])];
	return Effect.map(
		Effect.promise(() =>
			withScopes(
				app,
				scopes,
				async (tx) =>
					tx<StateRow[]>`
					select subject, state, observed_at, unreachable_since, seq
					from current_state
					where kind = ${kind} and subject > ${after}
					  and (${since}::timestamptz is null or observed_at >= ${since}::timestamptz)
					  and (${state}::text is null or state->>'state' = ${state})
					  and (${handle}::text is null or state->>'handle' = ${handle})
					  and (${owner}::text is null or state->>'owner' = ${owner})
					  and (${requiredFields.length} = 0 or state ?& ${tx.array(requiredFields)})
					order by subject asc limit ${limit + 1}`,
			),
		),
		(rows) => {
			const truncated = rows.length > limit;
			const page = truncated ? rows.slice(0, limit) : rows;
			let newest = "1970-01-01T00:00:00Z";
			const items = page.flatMap((row) => {
				const observedAt =
					typeof row.observed_at === "string"
						? row.observed_at
						: new Date(row.observed_at).toISOString();
				if (observedAt > newest) newest = observedAt;
				const item = map({ ...row, observed_at: observedAt });
				return item ? [item] : [];
			});
			return {
				schema_version: 1,
				freshness: { source: "lake", observed_at: newest, window_s: null },
				items,
				next_cursor: truncated ? (page[page.length - 1]?.subject ?? null) : null,
				truncated,
			};
		},
	);
}

/** Read the latest state for every entity of `kind` the caller can see, newest-subject paginated. */
export function readEntity(
	app: Sql,
	scopes: readonly string[],
	kind: ProjectionKind,
	opts: ReadOpts = {},
): Effect.Effect<ReadEnvelope> {
	return readProjectedEntity(app, scopes, kind, opts, (row) => ({
		...row.state,
		subject: row.subject,
		observed_at: row.observed_at,
		unreachable_since:
			row.unreachable_since === null
				? null
				: typeof row.unreachable_since === "string"
					? row.unreachable_since
					: new Date(row.unreachable_since).toISOString(),
	}));
}

/** Scope-filtered fuzzy retrieval for command surfaces; ranking occurs before the source limit. */
export function searchEntity(
	app: Sql,
	scopes: readonly string[],
	kind: ProjectionKind,
	query: string,
	limit = 32,
): Effect.Effect<ReadEnvelope> {
	const needle = query.trim().toLocaleLowerCase();
	const escaped = needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
	const subsequence = `%${Array.from(needle)
		.map((character) =>
			character.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"),
		)
		.join("%")}%`;
	const bounded = Math.min(Math.max(1, Math.floor(limit)), 32);
	return Effect.map(
		Effect.promise(() =>
			withScopes(
				app,
				scopes,
				async (tx) => tx<StateRow[]>`
					select subject, state, observed_at, unreachable_since, seq
					from current_state
					where kind = ${kind}
					  and lower(concat_ws(' ', subject, state::text)) like ${subsequence} escape E'\\\\'
					order by
					  (lower(subject) = ${needle}) desc,
					  (lower(subject) like ${`${escaped}%`} escape E'\\\\') desc,
					  (position(${needle} in lower(concat_ws(' ', subject, state::text))) > 0) desc,
					  char_length(subject) asc, subject asc
					limit ${bounded + 1}`,
			),
		),
		(rows) => {
			const page = rows.slice(0, bounded);
			let newest = "1970-01-01T00:00:00Z";
			const items = page.map((row) => {
				const observedAt =
					typeof row.observed_at === "string"
						? row.observed_at
						: new Date(row.observed_at).toISOString();
				if (observedAt > newest) newest = observedAt;
				return {
					...row.state,
					subject: row.subject,
					observed_at: observedAt,
					unreachable_since:
						row.unreachable_since === null
							? null
							: typeof row.unreachable_since === "string"
								? row.unreachable_since
								: new Date(row.unreachable_since).toISOString(),
				};
			});
			return {
				schema_version: 1,
				freshness: { source: "lake", observed_at: newest, window_s: null },
				items,
				next_cursor: null,
				truncated: rows.length > page.length,
			};
		},
	);
}

/** Read a typed projection without leaking projector-only subject/freshness fields into the item. */
export function readTypedEntity(
	app: Sql,
	scopes: readonly string[],
	kind: "attention" | "subscription",
	opts: ReadOpts = {},
): Effect.Effect<ReadEnvelope> {
	return readProjectedEntity(app, scopes, kind, opts, (row) => {
		if (kind !== "subscription") return row.state;
		// subscription.schema.json is intentionally closed; projector bookkeeping must not escape it.
		const item: Record<string, unknown> = {};
		for (const key of [
			"schema_version",
			"pattern",
			"filter",
			"tier",
			"window",
			"loud",
			"note",
			"owner",
			"updated_by",
			"updated_at",
			"storm",
		])
			if (row.state[key] !== undefined) item[key] = row.state[key];
		return item;
	});
}

export function readDeliveryConfig(
	app: Sql,
	scopes: readonly string[],
	opts: ReadOpts = {},
): Effect.Effect<ReadEnvelope> {
	const n = opts.limit ?? 200;
	const limit = Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 1000) : 200;
	const after = opts.cursor ?? "";
	const owner = opts.owner ?? null;
	const since = opts.since ?? null;
	return Effect.map(
		Effect.promise(() =>
			withScopes(
				app,
				scopes,
				async (tx) =>
					tx<
						{
							owner: string;
							channel: "matrix";
							target: string;
							verified: boolean;
							cocoon_until: string | null;
							next_digest_at: string | null;
							updated_at: string;
							updated_by: string;
						}[]
					>`select owner, channel, target, verified, cocoon_until, next_digest_at, updated_at, updated_by
					  from delivery_config
					  where owner > ${after} and (${owner}::text is null or owner = ${owner})
					    and (${since}::timestamptz is null or updated_at >= ${since}::timestamptz)
					  order by owner asc limit ${limit + 1}`,
			),
		),
		(rows) => {
			const truncated = rows.length > limit;
			const page = truncated ? rows.slice(0, limit) : rows;
			const items = page.map((row) => ({
				...row,
				cocoon_until: row.cocoon_until ? new Date(row.cocoon_until).toISOString() : null,
				next_digest_at: row.next_digest_at ? new Date(row.next_digest_at).toISOString() : null,
				updated_at: new Date(row.updated_at).toISOString(),
			}));
			return {
				schema_version: 1,
				freshness: {
					source: "delivery-config",
					observed_at: items.at(-1)?.updated_at ?? "1970-01-01T00:00:00Z",
					window_s: null,
				},
				items,
				next_cursor: truncated ? (page.at(-1)?.owner ?? null) : null,
				truncated,
			};
		},
	);
}

export function readSignalSourceModes(
	app: Sql,
	scopes: readonly string[],
	opts: ReadOpts = {},
): Effect.Effect<ReadEnvelope> {
	const n = opts.limit ?? 200;
	const limit = Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 1000) : 200;
	const after = opts.cursor ?? "";
	const since = opts.since ?? null;
	return Effect.map(
		Effect.promise(() =>
			withScopes(
				app,
				scopes,
				async (tx) =>
					tx<
						{
							source_service: string;
							mode: "normal" | "development";
							note: string | null;
							updated_at: string;
							updated_by: string;
						}[]
					>`select source_service, mode, note, updated_at, updated_by
					  from signal_source_modes where source_service > ${after}
					    and (${since}::timestamptz is null or updated_at >= ${since}::timestamptz)
					  order by source_service asc limit ${limit + 1}`,
			),
		),
		(rows) => {
			const truncated = rows.length > limit;
			const page = truncated ? rows.slice(0, limit) : rows;
			const items = page.map((row) => ({
				...row,
				updated_at: new Date(row.updated_at).toISOString(),
			}));
			return {
				schema_version: 1,
				freshness: {
					source: "signal-source-modes",
					observed_at: items.at(-1)?.updated_at ?? "1970-01-01T00:00:00Z",
					window_s: null,
				},
				items,
				next_cursor: truncated ? (page.at(-1)?.source_service ?? null) : null,
				truncated,
			};
		},
	);
}

export function readBoxUpdateRaw(
	app: Sql,
	scopes: readonly string[],
	boxId: string,
): Effect.Effect<Record<string, unknown> | null> {
	return Effect.map(
		Effect.promise(() =>
			withScopes(
				app,
				scopes,
				async (tx) =>
					tx<{ state: Record<string, unknown> }[]>`
					select state from current_state where kind = 'box_update' and subject = ${boxId}`,
			),
		),
		(rows) => {
			const state = rows.at(0)?.state;
			if (!state) return null;

			const nested = state["box_update_raw"] ?? state["raw"];
			const candidate =
				nested && typeof nested === "object" && !Array.isArray(nested)
					? (nested as Record<string, unknown>)
					: state;
			if (
				!Array.isArray(candidate["packages"]) ||
				!Array.isArray(candidate["vulns"]) ||
				typeof candidate["collected_at"] !== "string"
			)
				return null;
			return { ...candidate, box_id: boxId };
		},
	);
}
