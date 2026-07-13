// Structured stats.query (contract §3.1). Runs AS the caller inside a withScopes transaction, so
// RLS filters every row to the caller's grant. Field names are whitelisted or validated against a
// strict identifier regex before they touch SQL — no user string is ever concatenated raw.
// Honesty over omniscience: unsupported aggregations/fills are refused, never faked.

import { nanoid } from "nanoid";

import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import { embedText, EMBEDDING_MODEL, vectorLiteral } from "../semantic/embedding.ts";
import {
	mergeSemanticShape,
	type DimensionDescriptor,
	type MeasureDescriptor,
	type SemanticShape,
} from "../semantic/registry.ts";

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

export interface PreparedStructuredQuery {
	readonly request: QueryRequest;
	readonly sqlText: string;
	readonly params: readonly unknown[];
	readonly columns: readonly { name: string; type: string }[];
	readonly limit: number;
}

export class QueryError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

class StructuredExecutionError extends QueryError {
	constructor() {
		super("execution_rejected", "structured execution rejected; revise fields or aggregation");
		this.name = "StructuredExecutionError";
	}
}

function repairableExecutionCode(error: unknown): string | null {
	const code =
		error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: null;
	if (!code || code === "42501") return null;
	return /^(22|42)/.test(code) ? code : null;
}

function queryCorpusText(req: QueryRequest): string {
	const selected = (req.select ?? [])
		.map((field) => `${field.agg ?? "value"}:${field.field}`)
		.join(" ");
	const filters = Object.keys(req.where ?? {}).join(" ");
	return `successful query source ${req.from ?? "unknown"} select ${selected || "count"} group ${(req.group_by ?? []).join(" ") || "none"} filter-fields ${filters || "none"} bucket ${req.time?.bucket ?? "none"}`;
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
	edge_rel: "edge_rel",
	edge_to_kind: "edge_to_kind",
	edge_to_id: "edge_to_id",
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
const NUMERIC_PSEUDO = new Set(["seq", "task_id"]);
const TEMPORAL_PSEUDO = new Set(["ts", "received_at"]);

interface ResolvedSource {
	relation: string;
	typeFilter: string | null;
	dimensions: Record<string, DimensionDescriptor> | null;
	measures: Record<string, MeasureDescriptor> | null;
	allowedPseudo: ReadonlySet<string>;
	directFields: ReadonlySet<string>;
}

const EVENT_PSEUDO = new Set(Object.keys(PSEUDO).filter((field) => !field.startsWith("edge_")));
const RELATIONSHIP_PSEUDO = new Set(Object.keys(PSEUDO));

async function resolveSource(
	app: Sql,
	scopes: readonly string[],
	from: string,
): Promise<ResolvedSource> {
	if (from === "events")
		return {
			relation: "lake_events",
			typeFilter: null,
			dimensions: null,
			measures: null,
			allowedPseudo: EVENT_PSEUDO,
			directFields: new Set(),
		};
	if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(from)) {
		// With no grants, every well-formed type is intentionally indistinguishable: execute against
		// fail-closed RLS and return no rows rather than leaking catalog existence through errors.
		if (scopes.length === 0)
			return {
				relation: "lake_events",
				typeFilter: from,
				dimensions: null,
				measures: null,
				allowedPseudo: EVENT_PSEUDO,
				directFields: new Set(),
			};
		const visible = await withScopes(
			app,
			scopes,
			async (tx) =>
				tx<
					{
						dimensions: Record<string, DimensionDescriptor>;
						measures: Record<string, MeasureDescriptor>;
					}[]
				>`select dimensions, measures from semantic_registry_scoped
				   where type = ${from} order by scope`,
		);
		if (!visible[0]) throw new QueryError("bad_from", `unknown source ${from}`);
		let shape: SemanticShape = { dimensions: {}, measures: {}, joins: [] };
		for (const visibleShape of visible) {
			const merged = mergeSemanticShape(shape, { ...visibleShape, joins: [] });
			if (merged.drift.length > 0)
				throw new QueryError(
					"ambiguous_semantics",
					`source ${from} has incompatible field semantics across caller scopes`,
				);
			shape = merged.shape;
		}
		return {
			relation: "lake_events",
			typeFilter: from,
			dimensions: shape.dimensions,
			measures: shape.measures,
			allowedPseudo: EVENT_PSEUDO,
			directFields: new Set(),
		};
	}
	if (!IDENT_RE.test(from)) throw new QueryError("bad_from", `unknown source ${from}`);
	const views = await withScopes(
		app,
		scopes,
		async (tx) =>
			tx<{ relation_name: string; fields: Record<string, unknown> }[]>`
				select v.relation_name, v.fields
				from semantic_views v
				join pg_class c on c.relname = v.relation_name and c.relkind = 'v'
				join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
				where v.name = ${from} and v.enabled
				  and coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']`,
	);
	const relation = views[0]?.relation_name;
	if (!relation || !IDENT_RE.test(relation))
		throw new QueryError("bad_from", `unknown source ${from}`);
	const declared = views[0]?.fields ?? {};
	const dimensions: Record<string, DimensionDescriptor> = {};
	const measures: Record<string, MeasureDescriptor> = {};
	const directFields = new Set<string>();
	for (const [field, raw] of Object.entries(declared)) {
		if (field === "shape" || !IDENT_RE.test(field) || raw === null || typeof raw !== "object")
			continue;
		const descriptor = raw as Record<string, unknown>;
		directFields.add(field);
		if (typeof descriptor["kind"] === "string" || descriptor["type"] === "number")
			measures[field] = {
				kind: ["gauge", "counter", "delta", "timestamp"].includes(String(descriptor["kind"]))
					? (descriptor["kind"] as MeasureDescriptor["kind"])
					: null,
				unit: typeof descriptor["unit"] === "string" ? descriptor["unit"] : null,
			};
		else
			dimensions[field] = {
				type: descriptor["type"] === "boolean" ? "boolean" : "string",
				cardinality: null,
			};
	}
	const basePseudo =
		declared["shape"] === "event"
			? relation === "statistic_relationships"
				? RELATIONSHIP_PSEUDO
				: EVENT_PSEUDO
			: new Set<string>();
	return {
		relation,
		typeFilter: null,
		dimensions,
		measures,
		allowedPseudo: new Set([...basePseudo, ...directFields].filter((field) => PSEUDO[field])),
		directFields,
	};
}

function assertKnownField(source: ResolvedSource, field: string): void {
	if (source.allowedPseudo.has(field)) return;
	if (!source.dimensions?.[field] && !source.measures?.[field])
		throw new QueryError(
			"bad_field",
			`field ${field} is not registered on ${source.typeFilter ?? "registered view"}${nearestFields(source, field)}`,
		);
}

function nearestFields(source: ResolvedSource, field: string): string {
	const candidates = [
		...source.allowedPseudo,
		...Object.keys(source.dimensions ?? {}),
		...Object.keys(source.measures ?? {}),
	]
		.map((candidate) => ({ candidate, distance: editDistance(field, candidate) }))
		.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
		.slice(0, 3)
		.map(({ candidate }) => candidate);
	return candidates.length > 0 ? `; nearest: ${candidates.join(", ")}` : "";
}

function editDistance(a: string, b: string): number {
	let previous = [...Array(b.length + 1).keys()];
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1)
			current[j] = Math.min(
				(current[j - 1] ?? 0) + 1,
				(previous[j] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		previous = current;
	}
	return previous[b.length] ?? Math.max(a.length, b.length);
}

function assertAggregation(source: ResolvedSource, field: string, agg: string): void {
	if (agg === "count") return;
	assertKnownField(source, field);
	const measure = source.measures?.[field];
	if (agg === "count_distinct") return;
	if (!measure)
		throw new QueryError("agg_mismatch", `${agg} requires a registered measure: ${field}`);
	if (agg === "sum" && measure.kind !== "counter" && measure.kind !== "delta")
		throw new QueryError(
			"agg_mismatch",
			`sum requires counter|delta semantics; ${field} is ${measure.kind ?? "unclassified"}`,
		);
	if (agg === "avg" && measure.kind === "counter")
		throw new QueryError("agg_mismatch", `avg is invalid for counter semantics: ${field}`);
}

// Column expression for a field. Measures (numeric) and dimensions (text) live in JSONB.
function fieldExpr(source: ResolvedSource, field: string, numeric: boolean): string {
	const p = PSEUDO[field];
	if (p) return p;
	if (!IDENT_RE.test(field)) throw new QueryError("bad_field", `illegal field ${field}`);
	if (source.directFields.has(field)) return field;
	if (source.dimensions?.[field]?.type === "boolean")
		return `(case when jsonb_typeof(dimensions->'${field}') = 'boolean' then (dimensions->>'${field}')::boolean end)`;
	return numeric ? `(measures->>'${field}')::numeric` : `dimensions->>'${field}'`;
}

function outputType(source: ResolvedSource, field: string): "string" | "number" | "boolean" {
	if (source.measures?.[field] || NUMERIC_PSEUDO.has(field)) return "number";
	if (source.dimensions?.[field]?.type === "boolean") return "boolean";
	return "string";
}

function aggExpr(source: ResolvedSource, field: string, agg: string, isMeasure: boolean): string {
	if (agg === "count") return "count(*)";
	const col = fieldExpr(source, field, isMeasure);
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
			return `(array_agg(${fieldExpr(source, field, isMeasure)} order by received_at desc))[1]`;
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

export async function prepareStructured(
	app: Sql,
	scopes: readonly string[],
	req: QueryRequest,
): Promise<PreparedStructuredQuery> {
	if (!req.from) throw new QueryError("missing_from", "structured query requires `from`");
	const source = await resolveSource(app, scopes, req.from);

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
		assertKnownField(source, g);
		if (source.measures?.[g]) throw new QueryError("bad_field", `cannot group by measure ${g}`);
		const expr = fieldExpr(source, g, false);
		const alias = PSEUDO[g] ? g.replace(".", "_") : g;
		if (!IDENT_RE.test(alias)) throw new QueryError("bad_field", `illegal group field ${g}`);
		selects.push(`${expr} as ${alias}`);
		cols.push({ name: alias, type: outputType(source, g) });
		groupExprs.push(expr);
	}

	for (const s of req.select ?? []) {
		assertKnownField(source, s.field);
		if (s.as && !IDENT_RE.test(s.as)) throw new QueryError("bad_alias", `illegal alias ${s.as}`);
		if (s.agg) {
			if (!AGGS.has(s.agg)) throw new QueryError("bad_agg", `unsupported aggregation ${s.agg}`);
			assertAggregation(source, s.field, s.agg);
			const alias = s.as ?? `${s.agg}_${s.field.replace(/[^a-z0-9_]/g, "_")}`;
			selects.push(
				`${aggExpr(source, s.field, s.agg, Boolean(source.measures?.[s.field]))} as ${alias}`,
			);
			cols.push({ name: alias, type: "number" });
		} else {
			const numeric = Boolean(source.measures?.[s.field]);
			const expr = fieldExpr(source, s.field, numeric);
			const alias = s.as ?? (PSEUDO[s.field] ? s.field.replace(".", "_") : s.field);
			if (!IDENT_RE.test(alias)) throw new QueryError("bad_alias", `illegal alias ${alias}`);
			selects.push(`${expr} as ${alias}`);
			cols.push({ name: alias, type: outputType(source, s.field) });
			groupExprs.push(expr);
		}
	}
	if (selects.length === 0) {
		selects.push("count(*) as count");
		cols.push({ name: "count", type: "number" });
	}

	const whereParts: string[] = [];
	const params: unknown[] = [];
	if (source.typeFilter) {
		params.push(source.typeFilter);
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
		assertKnownField(source, field);
		const isMeasure = Boolean(source.measures?.[field]);
		const isBoolean = source.dimensions?.[field]?.type === "boolean";
		const expr = fieldExpr(source, field, isMeasure);
		if (cond !== null && typeof cond === "object" && "op" in cond) {
			const c = cond as { op: string; value: unknown };
			if (c.op === "is_null" || c.op === "not_null") {
				whereParts.push(`${expr} is ${c.op === "not_null" ? "not " : ""}null`);
				continue;
			}
			if (c.op === "in") {
				if (!Array.isArray(c.value) || c.value.length === 0 || c.value.length > 1000)
					throw new QueryError("bad_where", "in requires an array of 1..1000 values");
				if (isMeasure && c.value.some((value) => typeof value !== "number"))
					throw new QueryError("bad_where", `measure ${field} requires numeric filter values`);
				if (isBoolean && c.value.some((value) => typeof value !== "boolean"))
					throw new QueryError("bad_where", `field ${field} requires boolean filter values`);
				params.push(c.value);
				whereParts.push(`${expr} = any($${String(params.length)})`);
				continue;
			}
			const op = WHERE_OPS[c.op];
			if (!op) throw new QueryError("bad_where", `unsupported where op ${c.op}`);
			if (isBoolean && c.op !== "eq" && c.op !== "ne")
				throw new QueryError("bad_where", `operator ${c.op} is invalid for boolean field ${field}`);
			if (c.op === "like" && (isMeasure || NUMERIC_PSEUDO.has(field) || TEMPORAL_PSEUDO.has(field)))
				throw new QueryError("bad_where", `like requires a textual field: ${field}`);
			if ((isMeasure || NUMERIC_PSEUDO.has(field)) && typeof c.value !== "number")
				throw new QueryError("bad_where", `field ${field} requires a numeric filter value`);
			if (isBoolean && typeof c.value !== "boolean")
				throw new QueryError("bad_where", `field ${field} requires a boolean filter value`);
			params.push(c.value);
			whereParts.push(`${expr} ${op} $${String(params.length)}`);
		} else {
			if (cond === null) {
				whereParts.push(`${expr} is null`);
				continue;
			}
			if ((isMeasure || NUMERIC_PSEUDO.has(field)) && typeof cond !== "number")
				throw new QueryError("bad_where", `field ${field} requires a numeric filter value`);
			if (isBoolean && typeof cond !== "boolean")
				throw new QueryError("bad_where", `field ${field} requires a boolean filter value`);
			params.push(cond);
			whereParts.push(`${expr} = $${String(params.length)}`);
		}
	}

	const orderParts: string[] = [];
	const selectedAliases = new Set(cols.map(({ name }) => name));
	const groupedQuery = groupExprs.length > 0 || (req.select ?? []).some((select) => select.agg);
	for (const o of req.order ?? []) {
		const alias = PSEUDO[o.field] ? o.field.replace(".", "_") : o.field;
		if (!IDENT_RE.test(alias)) throw new QueryError("bad_order", `illegal order field ${o.field}`);
		if (selectedAliases.has(alias))
			orderParts.push(`${alias} ${o.dir === "desc" ? "desc" : "asc"}`);
		else {
			if (groupedQuery)
				throw new QueryError(
					"bad_order",
					`grouped queries must order by a selected alias: ${alias}`,
				);
			assertKnownField(source, o.field);
			orderParts.push(
				`${fieldExpr(source, o.field, Boolean(source.measures?.[o.field]))} ${o.dir === "desc" ? "desc" : "asc"}`,
			);
		}
	}

	// coerce limit to a sane positive int so a non-numeric/negative value is a clean 400, not a raw
	// Postgres 500 (sub-agent L1)
	const rawLimit = Number(req.limit ?? 1000);
	if (req.limit != null && !Number.isFinite(rawLimit))
		throw new QueryError("bad_limit", "limit must be a number");
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(1, Math.floor(rawLimit)), 100000)
		: 1000;
	let sqlText = `select ${selects.join(", ")} from ${source.relation}`;
	if (whereParts.length) sqlText += ` where ${whereParts.join(" and ")}`;
	if (groupExprs.length) sqlText += ` group by ${groupExprs.join(", ")}`;
	if (orderParts.length) sqlText += ` order by ${orderParts.join(", ")}`;
	sqlText += ` limit ${String(limit + 1)}`;
	return { request: req, sqlText, params, columns: cols, limit };
}

/** Validate the server-compiled statement with the dedicated read-only role without executing it. */
export async function dryPlanStructured(
	ro: Sql,
	scopes: readonly string[],
	prepared: PreparedStructuredQuery,
): Promise<void> {
	try {
		await withScopes(ro, scopes, async (tx) => {
			await tx`set local statement_timeout = '5s'`;
			await tx.unsafe(`explain (format json) ${prepared.sqlText}`, prepared.params as never[]);
		});
	} catch (error) {
		const code = repairableExecutionCode(error);
		if (code) throw new StructuredExecutionError();
		throw error;
	}
}

async function persistQueryInTx(
	tx: Sql,
	scopes: readonly string[],
	prepared: PreparedStructuredQuery,
	result: Omit<QueryResult, "query_ref">,
): Promise<QueryResult> {
	const ref = `q_${nanoid(16)}`;
	const content = queryCorpusText(prepared.request);
	const embedding = vectorLiteral(embedText(content));
	await tx`
			insert into query_history
				(query_ref, request, sql_text, params, scopes, columns, row_count, execution_ms)
			values
				(${ref}, ${tx.json(prepared.request as never)}, ${prepared.sqlText},
				 ${tx.json(prepared.params as never)}, ${tx.json([...scopes])},
				 ${tx.json(prepared.columns as never)}, ${result.row_count}, ${result.execution_ms})`;
	await tx`
			insert into semantic_documents
				(id, kind, source_ref, content, scopes, embedding, embedding_model)
			values
				(${`query:${ref}`}, 'query', ${ref}, ${content}, ${tx.json([...scopes])},
				 ${embedding}::vector, ${EMBEDDING_MODEL})`;
	return { ...result, query_ref: ref };
}

async function persistQuery(
	app: Sql,
	scopes: readonly string[],
	prepared: PreparedStructuredQuery,
	result: Omit<QueryResult, "query_ref">,
): Promise<QueryResult> {
	return withScopes(app, scopes, (tx) => persistQueryInTx(tx, scopes, prepared, result));
}

async function executePreparedInTx(
	tx: Sql,
	prepared: PreparedStructuredQuery,
	start: number,
): Promise<Omit<QueryResult, "query_ref">> {
	const rows = await tx.unsafe(prepared.sqlText, prepared.params as never[]);
	const arr = rows as unknown as Record<string, unknown>[];
	const truncated = arr.length > prepared.limit;
	const out = (truncated ? arr.slice(0, prepared.limit) : arr).map((row) =>
		prepared.columns.map((column) => {
			const value = row[column.name] ?? null;
			return column.type === "number" && value !== null ? Number(value) : value;
		}),
	);
	return {
		schema_version: 1,
		columns: [...prepared.columns],
		rows: out,
		row_count: out.length,
		execution_ms: Date.now() - start,
		freshness: { source: "lake", observed_at: new Date().toISOString(), window_s: null },
		...(truncated ? { truncated: true } : {}),
	};
}

/**
 * Execute only server-compiled structured SQL. `executionSql` is console_ro for the assistant path;
 * direct structured API calls retain their existing console_app execution role.
 */
export async function runPreparedStructured(
	app: Sql,
	executionSql: Sql,
	scopes: readonly string[],
	prepared: PreparedStructuredQuery,
): Promise<QueryResult> {
	const start = Date.now();
	let result: Omit<QueryResult, "query_ref">;
	try {
		result = await withScopes(executionSql, scopes, async (tx) => {
			if (executionSql !== app) {
				await tx`set local statement_timeout = '20s'`;
			}
			return executePreparedInTx(tx, prepared, start);
		});
	} catch (error) {
		const code = repairableExecutionCode(error);
		if (code) throw new StructuredExecutionError();
		throw error;
	}
	return persistQuery(app, scopes, prepared, result);
}

export async function runStructured(
	app: Sql,
	scopes: readonly string[],
	req: QueryRequest,
): Promise<QueryResult> {
	const prepared = await prepareStructured(app, scopes, req);
	const start = Date.now();
	return withScopes(app, scopes, async (tx) => {
		const result = await executePreparedInTx(tx, prepared, start);
		return persistQueryInTx(tx, scopes, prepared, result);
	});
}
