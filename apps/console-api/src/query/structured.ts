// Structured stats.query (contract §3.1). Runs AS the caller inside a withScopes transaction, so
// RLS filters every row to the caller's grant. Field names are whitelisted or validated against a
// strict identifier regex before they touch SQL — no user string is ever concatenated raw.
// Honesty over omniscience: unsupported aggregations/fills are refused, never faked.

import { nanoid } from "nanoid";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";

export interface QueryRequest {
	schema_version: 1;
	mode: "structured" | "sql";
	from?: string;
	select?: { field: string; agg?: string | null; as?: string }[];
	where?: Record<string, unknown>;
	group_by?: string[];
	time?: {
		from?: string;
		to?: string | null;
		bucket?: string | null;
		fill?: string | null;
		coverage?: boolean;
	} | null;
	order?: { field: string; dir: "asc" | "desc" }[] | null;
	limit?: number | null;
}

export interface QueryResult {
	schema_version: 1;
	columns: { name: string; type: string }[];
	rows: unknown[][];
	row_count: number;
	execution_ms: number | null;
	freshness: { source: string; observed_at: string; window_s: number | null };
	query_ref: string;
	truncated?: boolean;
}

export class QueryError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

const IDENT_RE = /^[a-z0-9_]+$/;
const PSEUDO: Record<string, string> = {
	type: "type",
	subject: "subject",
	subject_kind: "subject_kind",
	severity: "severity",
	scope: "scope",
	task_id: "task_id",
	ts: "ts",
	received_at: "received_at",
	seq: "seq",
	"source.service": "source_service",
	"source.host": "source_host",
	"source.agent": "source_agent",
};
const AGGS = new Set([
	"sum",
	"avg",
	"min",
	"max",
	"count",
	"count_distinct",
	"p50",
	"p95",
	"p99",
	"last",
]);
const WHERE_OPS: Record<string, string> = {
	eq: "=",
	ne: "<>",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
	like: "like",
};

// Column expression for a field. Measures (numeric) and dimensions (text) live in JSONB.
function fieldExpr(field: string, numeric: boolean): string {
	const p = PSEUDO[field];
	if (p) return p;
	if (!IDENT_RE.test(field)) throw new QueryError("bad_field", `illegal field ${field}`);
	return numeric ? `(measures->>'${field}')::numeric` : `dimensions->>'${field}'`;
}

function aggExpr(field: string, agg: string): string {
	if (agg === "count") return "count(*)";
	const numeric = agg !== "count_distinct";
	const col = fieldExpr(field, numeric && agg !== "last");
	switch (agg) {
		case "count_distinct":
			return `count(distinct ${col})`;
		case "sum":
		case "avg":
		case "min":
		case "max":
			return `${agg}(${col})`;
		case "p50":
		case "p95":
		case "p99": {
			const pct = agg === "p50" ? "0.5" : agg === "p95" ? "0.95" : "0.99";
			return `percentile_cont(${pct}) within group (order by ${col})`;
		}
		case "last":
			return `(array_agg(${fieldExpr(field, false)} order by received_at desc))[1]`;
		default:
			throw new QueryError("bad_agg", `unsupported aggregation ${agg}`);
	}
}

function bucketSeconds(bucket: string): number {
	const m = /^([0-9]+)(s|m|h|d)$/.exec(bucket);
	if (!m) throw new QueryError("bad_bucket", `bad bucket ${bucket}`);
	const n = Number(m[1]);
	return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

export async function runStructured(
	app: Sql,
	scopes: readonly string[],
	req: QueryRequest,
): Promise<QueryResult> {
	if (!req.from) throw new QueryError("missing_from", "structured query requires `from`");
	// N1a serves the `events` view (the Void) and single emission types (from = a type).
	const isType = req.from !== "events";
	if (isType && !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(req.from))
		throw new QueryError("bad_from", `unknown source ${req.from}`);

	const selects: string[] = [];
	const cols: { name: string; type: string }[] = [];
	const groupExprs: string[] = [];

	if (req.time?.bucket) {
		if (req.time.fill && req.time.fill !== "none" && req.time.fill !== "null")
			throw new QueryError(
				"unsupported_fill",
				`fill '${req.time.fill}' not supported in this build (use none|null)`,
			);
		if (req.time.coverage)
			throw new QueryError("unsupported_coverage", "coverage not supported in this build");
		const n = bucketSeconds(req.time.bucket);
		const bucketExpr = `to_timestamp(floor(extract(epoch from received_at)/${String(n)})*${String(n)})`;
		selects.push(`${bucketExpr} as bucket`);
		cols.push({ name: "bucket", type: "timestamp" });
		groupExprs.push(bucketExpr);
	}

	for (const g of req.group_by ?? []) {
		const expr = fieldExpr(g, false);
		const alias = PSEUDO[g] ? g.replace(".", "_") : g;
		if (!IDENT_RE.test(alias)) throw new QueryError("bad_field", `illegal group field ${g}`);
		selects.push(`${expr} as ${alias}`);
		cols.push({ name: alias, type: "string" });
		groupExprs.push(expr);
	}

	for (const s of req.select ?? []) {
		if (s.as && !IDENT_RE.test(s.as)) throw new QueryError("bad_alias", `illegal alias ${s.as}`);
		if (s.agg) {
			if (!AGGS.has(s.agg)) throw new QueryError("bad_agg", `unsupported aggregation ${s.agg}`);
			const alias = s.as ?? `${s.agg}_${s.field.replace(/[^a-z0-9_]/g, "_")}`;
			selects.push(`${aggExpr(s.field, s.agg)} as ${alias}`);
			cols.push({ name: alias, type: "number" });
		} else {
			const expr = fieldExpr(s.field, false);
			const alias = s.as ?? (PSEUDO[s.field] ? s.field.replace(".", "_") : s.field);
			if (!IDENT_RE.test(alias)) throw new QueryError("bad_alias", `illegal alias ${alias}`);
			selects.push(`${expr} as ${alias}`);
			cols.push({ name: alias, type: "string" });
			groupExprs.push(expr);
		}
	}
	if (selects.length === 0) {
		selects.push("count(*) as count");
		cols.push({ name: "count", type: "number" });
	}

	const whereParts: string[] = [];
	const params: unknown[] = [];
	if (isType) {
		params.push(req.from);
		whereParts.push(`type = $${String(params.length)}`);
	}
	if (req.time?.from) {
		params.push(req.time.from);
		whereParts.push(`received_at >= $${String(params.length)}::timestamptz`);
	}
	if (req.time?.to) {
		params.push(req.time.to);
		whereParts.push(`received_at <= $${String(params.length)}::timestamptz`);
	}
	for (const [field, cond] of Object.entries(req.where ?? {})) {
		const numeric =
			typeof cond === "object" &&
			cond !== null &&
			"op" in cond &&
			["gt", "gte", "lt", "lte"].includes((cond as { op: string }).op);
		const expr = fieldExpr(field, numeric);
		if (cond !== null && typeof cond === "object" && "op" in cond) {
			const c = cond as { op: string; value: unknown };
			const op = WHERE_OPS[c.op];
			if (!op) throw new QueryError("bad_where", `unsupported where op ${c.op}`);
			params.push(c.value);
			whereParts.push(`${expr} ${op} $${String(params.length)}`);
		} else {
			params.push(cond);
			whereParts.push(`${expr} = $${String(params.length)}`);
		}
	}

	const orderParts: string[] = [];
	for (const o of req.order ?? []) {
		const alias = PSEUDO[o.field] ? o.field.replace(".", "_") : o.field;
		if (!IDENT_RE.test(alias)) throw new QueryError("bad_order", `illegal order field ${o.field}`);
		orderParts.push(`${alias} ${o.dir === "desc" ? "desc" : "asc"}`);
	}

	// coerce limit to a sane positive int so a non-numeric/negative value is a clean 400, not a raw
	// Postgres 500 (sub-agent L1)
	const rawLimit = Number(req.limit ?? 1000);
	if (req.limit != null && !Number.isFinite(rawLimit))
		throw new QueryError("bad_limit", "limit must be a number");
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(1, Math.floor(rawLimit)), 100000)
		: 1000;
	let sqlText = `select ${selects.join(", ")} from lake_events`;
	if (whereParts.length) sqlText += ` where ${whereParts.join(" and ")}`;
	if (groupExprs.length) sqlText += ` group by ${groupExprs.join(", ")}`;
	if (orderParts.length) sqlText += ` order by ${orderParts.join(", ")}`;
	sqlText += ` limit ${String(limit + 1)}`;

	// query_ref is a durable id for provenance peek + re-run; the ref→SQL mapping is persisted with
	// the observability engine in Phase 2 (N1a returns the id, storage lands there).
	const ref = `q_${nanoid(16)}`;

	const start = Date.now();
	const rows = await withScopes(app, scopes, async (tx) => tx.unsafe(sqlText, params as never[]));
	const arr = rows as unknown as Record<string, unknown>[];
	const truncated = arr.length > limit;
	const out = (truncated ? arr.slice(0, limit) : arr).map((r) =>
		cols.map((c) => r[c.name] ?? null),
	);
	return {
		schema_version: 1,
		columns: cols,
		rows: out,
		row_count: out.length,
		execution_ms: Date.now() - start,
		freshness: { source: "lake", observed_at: new Date().toISOString(), window_s: null },
		query_ref: ref,
		...(truncated ? { truncated: true } : {}),
	};
}
