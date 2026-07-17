import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { asynchronously } from "#domain/iteration";

import { canMutateScope } from "../auth/grants.ts";
import type { Principal } from "../auth/principal.ts";
import type { Sql } from "../db/pool.ts";
import { withScopes } from "../db/pool.ts";
import { readQueryRecord } from "../query/history.ts";
import { QueryError, runStructured, type QueryResult } from "../query/structured.ts";
import { materializePanel } from "../render/engine.ts";
import type { MaterializedPanel, PanelSpecV2, RenderArtifact } from "../render/types.ts";
import { dashboardSaveSchema } from "../render/validation.ts";

type DashboardInput = ReturnType<typeof dashboardSaveSchema.parse>;

interface ItemRow {
	id: string;
	title: string;
	scope: string;
	is_home: boolean;
	created_by: string | null;
	responsible_human: string | null;
	payload: DashboardPayload;
	updated_at: string | Date;
}

interface ListItemRow extends ItemRow {
	cursor_position: string;
}

interface DashboardPayload {
	schema_version: 1;
	layout: Record<string, unknown>;
	panels: PanelSpecV2[];
	query_refs: string[];
	branch: Record<string, unknown> | null;
	time: Record<string, unknown> | null;
}

interface MutationRow {
	request_hash: string;
	dashboard_id: string;
}

export class DashboardError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function dashboardTargetScope(principal: Principal, requestedScope?: string): string | null {
	if (requestedScope) return requestedScope;
	const personal = principal.kind === "agent" ? principal.id : `user:${principal.id}`;
	return principal.scopes.includes(personal)
		? personal
		: ([...principal.scopes].toSorted()[0] ?? null);
}

async function rebindQueryRef(
	app: Sql,
	authorScopes: readonly string[],
	targetScope: string,
	queryRef: string,
): Promise<QueryResult> {
	const record = await readQueryRecord(app, authorScopes, queryRef);
	if (!record)
		throw new DashboardError("query_not_visible", "one or more panel query refs are not visible");
	try {
		// Re-execution under only the dashboard scope proves that every future holder of this scope can
		// resolve the ref. The saved artifact never inherits the author's broader grant set.
		return await runStructured(app, [targetScope], record.request);
	} catch (error) {
		if (error instanceof DashboardError) throw error;
		if (error instanceof QueryError)
			throw new DashboardError(
				"query_not_shareable",
				"one or more panel queries cannot execute within the dashboard scope",
			);
		throw error;
	}
}

const STAT_BINDING_SOURCE = String.raw`\{\{stat:([^#}\s]+)#([a-zA-Z0-9_]+)(?:\[([a-zA-Z0-9_]+)\])?\}\}`;

function statBindings(prose: string): RegExpStringIterator<RegExpExecArray> {
	return prose.matchAll(new RegExp(STAT_BINDING_SOURCE, "g"));
}

async function rebindDashboardPayload(
	app: Sql,
	authorScopes: readonly string[],
	targetScope: string,
	input: DashboardInput,
): Promise<DashboardPayload> {
	const rebound = new Map<string, QueryResult>();
	async function bind(ref: string): Promise<QueryResult> {
		const known = rebound.get(ref);
		if (known) return known;
		const result = await rebindQueryRef(app, authorScopes, targetScope, ref);
		rebound.set(ref, result);
		return result;
	}
	const panels: PanelSpecV2[] = [];
	for await (const raw of asynchronously(input.panels as PanelSpecV2[])) {
		let panel: PanelSpecV2 = {
			...raw,
			render: null,
			narrative: null,
			summary: null,
			recommendations: null,
		};
		if (raw.query_ref) {
			const result = await bind(raw.query_ref);
			panel.query_ref = result.query_ref;
		}
		if (typeof raw.prose === "string") {
			let prose = raw.prose;
			for await (const match of asynchronously(statBindings(raw.prose))) {
				const originalRef = match[1];
				if (!originalRef) continue;
				const result = await bind(originalRef);
				prose = prose.replaceAll(`stat:${originalRef}#`, `stat:${result.query_ref}#`);
			}
			panel = { ...panel, prose };
		}
		panels.push(panel);
	}
	const branch = input.branch ? structuredClone(input.branch) : null;
	const selectedRef = branch?.selected_mark?.query_ref;
	if (branch?.selected_mark) {
		delete branch.selected_mark.datum;
		delete branch.selected_mark.value;
		if (selectedRef) branch.selected_mark.query_ref = (await bind(selectedRef)).query_ref;
	}
	return {
		schema_version: 1,
		layout: input.layout ?? {},
		panels,
		query_refs: [...new Set([...rebound.values()].map(({ query_ref }) => query_ref))],
		branch,
		time: input.time ?? null,
	};
}

function requestHash(input: DashboardInput): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function dashboardById(sql: Sql, id: string): Promise<ItemRow | null> {
	const rows = await sql<ItemRow[]>`
		select id, title, scope, is_home, created_by, responsible_human, payload, updated_at
		from library_items where id = ${id}`;
	return rows[0];
}

export async function saveDashboard(
	db: { app: Sql; writer: Sql },
	principal: Principal,
	input: DashboardInput,
): Promise<Record<string, unknown>> {
	const scope = dashboardTargetScope(principal, input.scope);
	if (!scope || !principal.scopes.includes(scope))
		throw new DashboardError("scope_denied", "dashboard scope is not visible to the caller");
	if (!(await canMutateScope(db.writer, principal, scope)))
		throw new DashboardError("scope_denied", "editor relation required for the dashboard scope");
	const hash = requestHash(input);
	const existing = await db.writer<MutationRow[]>`
		select request_hash, dashboard_id from dashboard_mutations
		where principal_id = ${principal.id} and request_id = ${input.id}`;
	const existingMutation = existing.at(0);
	if (existingMutation) {
		if (existingMutation.request_hash !== hash)
			throw new DashboardError("id_reused", "mutation id was already used with a different body");
		const item = await dashboardById(db.writer, existingMutation.dashboard_id);
		if (!item) throw new Error("dashboard mutation points to a missing item");
		if (item.scope !== scope || !principal.scopes.includes(item.scope))
			throw new DashboardError("scope_denied", "dashboard scope is not visible to the caller");
		return itemEnvelope(item);
	}
	const payload = await rebindDashboardPayload(db.app, principal.scopes, scope, input);
	const id = `dash_${createHash("sha256").update(`${principal.id}\0${input.id}`).digest("hex").slice(0, 24)}`;
	return db.writer.begin(async (tx) => {
		const claimed = await tx<MutationRow[]>`
			insert into dashboard_mutations (principal_id, request_id, request_hash, dashboard_id)
			values (${principal.id}, ${input.id}, ${hash}, ${id})
			on conflict (principal_id, request_id) do nothing
			returning request_hash, dashboard_id`;
		if (!claimed.at(0)) {
			const raced = await tx<MutationRow[]>`
				select request_hash, dashboard_id from dashboard_mutations
				where principal_id = ${principal.id} and request_id = ${input.id}`;
			const previous = raced.at(0);
			if (!previous || previous.request_hash !== hash)
				throw new DashboardError("id_reused", "mutation id was already used with a different body");
			const item = await dashboardById(tx as unknown as Sql, previous.dashboard_id);
			if (!item) throw new Error("dashboard mutation points to a missing item");
			if (item.scope !== scope || !principal.scopes.includes(item.scope))
				throw new DashboardError("scope_denied", "dashboard scope is not visible to the caller");
			return itemEnvelope(item);
		}

		const rows = await tx<ItemRow[]>`
			insert into library_items
			  (id, entity_id, kind, title, scope, project, status, render_mode, created_by,
			   responsible_human, protection, properties, payload)
			values
			  (${id}, ${id}, 'artifact', ${input.title}, ${scope}, 'unsorted', 'verified-shared',
			   'html', ${principal.id}, ${principal.kind === "human" ? principal.id : null},
			   'semi', ${tx.json({ artifact_type: "dashboard" })}, ${tx.json(payload as never)})
			returning id, title, scope, is_home, created_by, responsible_human, payload, updated_at`;
		return itemEnvelope(rows[0]);
	});
}

function iso(value: string | Date): string {
	return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function itemEnvelope(row: ItemRow): Record<string, unknown> {
	const parentDashboardId = row.payload.branch?.["parent_dashboard_id"];
	const parentQuestion = row.payload.branch?.["parent_question"];
	return {
		schema_version: 1,
		id: row.id,
		kind: "artifact",
		title: row.title,
		scope: row.scope,
		is_home: row.is_home,
		created_by: row.created_by,
		responsible_human: row.responsible_human,
		updated_at: iso(row.updated_at),
		panel_count: row.payload.panels.length,
		is_investigation: row.payload.branch !== null,
		parent_id: typeof parentDashboardId === "string" ? parentDashboardId : null,
		parent_question: typeof parentQuestion === "string" ? parentQuestion : null,
		payload: row.payload,
	};
}

export async function listDashboards(
	app: Sql,
	scopes: readonly string[],
	cursorSecret: string,
	opts: { limit?: number; cursor?: string } = {},
): Promise<Record<string, unknown>> {
	const rawLimit = opts.limit ?? 200;
	const limit = Number.isFinite(rawLimit)
		? Math.min(1_000, Math.max(1, Math.floor(rawLimit)))
		: 200;
	let cursor: { position: string; id: string } | null = null;
	if (opts.cursor) {
		try {
			const [encoded, signature, extra] = opts.cursor.split(".");
			if (!encoded || !signature || extra) throw new Error("invalid cursor");
			const expected = createHmac("sha256", cursorSecret).update(encoded).digest();
			const supplied = Buffer.from(signature, "base64url");
			if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
				throw new Error("invalid cursor");
			const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
				v?: unknown;
				position?: unknown;
				id?: unknown;
			};
			if (
				decoded.v !== 1 ||
				typeof decoded.position !== "string" ||
				!/^\d+(?:\.\d{1,6})?$/.test(decoded.position) ||
				typeof decoded.id !== "string" ||
				!/^dash_[A-Za-z0-9_-]{8,64}$/.test(decoded.id)
			)
				throw new Error("invalid cursor");
			cursor = { position: decoded.position, id: decoded.id };
		} catch {
			throw new DashboardError("bad_cursor", "invalid dashboard cursor");
		}
	}
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<ListItemRow[]>`
			select id, title, scope, is_home, created_by, responsible_human, payload, updated_at,
			       extract(epoch from updated_at)::text as cursor_position
			from library_items where kind = 'artifact'
			  and (properties->>'artifact_type' = 'dashboard' or payload ? 'panels')
			  and (${cursor?.position ?? null}::numeric is null
			       or (extract(epoch from updated_at), id) < (${cursor?.position ?? null}::numeric, ${cursor?.id ?? null}::text))
			order by updated_at desc, id desc limit ${limit + 1}`,
	);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		schema_version: 1,
		freshness: { source: "library", observed_at: new Date().toISOString(), window_s: null },
		items: page.map((row) => {
			const item = itemEnvelope(row);
			delete item["payload"];
			return item;
		}),
		next_cursor: rows.length > page.length && last ? dashboardCursor(cursorSecret, last) : null,
		truncated: rows.length > page.length,
	};
}

function dashboardCursor(secret: string, row: Pick<ListItemRow, "cursor_position" | "id">): string {
	const encoded = Buffer.from(
		JSON.stringify({ v: 1, position: row.cursor_position, id: row.id }),
	).toString("base64url");
	const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
	return `${encoded}.${signature}`;
}

interface LibraryPageOptions {
	limit?: number;
	cursor?: string;
}

function libraryPageOffset(
	secret: string,
	cursor: string | undefined,
	fingerprint: string,
): number {
	if (!cursor) return 0;
	try {
		const [encoded, signature, extra] = cursor.split(".");
		if (!encoded || !signature || extra) throw new Error("invalid cursor");
		const expected = createHmac("sha256", secret).update(encoded).digest();
		const supplied = Buffer.from(signature, "base64url");
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
			throw new Error("invalid cursor");
		const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
			v?: unknown;
			offset?: unknown;
			fingerprint?: unknown;
		};
		if (
			decoded.v !== 1 ||
			!Number.isSafeInteger(decoded.offset) ||
			Number(decoded.offset) < 0 ||
			Number(decoded.offset) > 1_000_000 ||
			decoded.fingerprint !== fingerprint
		)
			throw new Error("invalid cursor");
		return Number(decoded.offset);
	} catch {
		throw new DashboardError("bad_cursor", "invalid Library cursor");
	}
}

function libraryPageCursor(secret: string, offset: number, fingerprint: string): string {
	const encoded = Buffer.from(JSON.stringify({ v: 1, offset, fingerprint })).toString("base64url");
	const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
	return `${encoded}.${signature}`;
}

function libraryLimit(raw: number | undefined): number {
	const value = raw ?? 200;
	return Number.isFinite(value) ? Math.min(1_000, Math.max(1, Math.floor(value))) : 200;
}

async function readDashboardRow(
	app: Sql,
	scopes: readonly string[],
	id: string,
): Promise<ItemRow | null> {
	return withScopes(app, scopes, async (tx) => {
		const rows = await tx<ItemRow[]>`
			select id, title, scope, is_home, created_by, responsible_human, payload, updated_at
			from library_items where id = ${id} and kind = 'artifact'
			  and (properties->>'artifact_type' = 'dashboard' or payload ? 'panels')`;
		return rows[0];
	});
}

function unavailablePanel(panel: PanelSpecV2): MaterializedPanel {
	const refusal: PanelSpecV2 = {
		schema_version: 2,
		type: "refusal",
		title: panel.title,
		refusal: {
			reason: "This panel's query is not visible in the current caller scope.",
			suggestions: ["Request access or replace this panel with a visible statistic."],
		},
	};
	const render: RenderArtifact = {
		schema_version: 1,
		renderer: "native",
		spec: null,
		data_query_ref: null,
		selection_reason: "query ref unavailable to caller",
		forecast_strategy: null,
	};
	refusal.render = render;
	return { schema_version: 1, panel: refusal, result: null, render };
}

function nativePanel(panel: PanelSpecV2): MaterializedPanel {
	const render: RenderArtifact = {
		schema_version: 1,
		renderer: "native",
		spec: null,
		data_query_ref: null,
		selection_reason: `${panel.type} panel is rendered natively`,
		forecast_strategy: null,
	};
	const rendered = { ...panel, render };
	return { schema_version: 1, panel: rendered, result: null, render };
}

export async function materializeTextPanel(
	app: Sql,
	scopes: readonly string[],
	panel: PanelSpecV2,
): Promise<MaterializedPanel> {
	if (typeof panel.prose !== "string" || !panel.prose.includes("{{stat:"))
		return nativePanel(panel);
	const bindings: NonNullable<RenderArtifact["bindings"]> = [];
	let prose = panel.prose;
	for await (const match of asynchronously(statBindings(panel.prose))) {
		const [binding, queryRef, column] = match;
		if (!queryRef || !column) continue;
		const record = await readQueryRecord(app, scopes, queryRef);
		if (!record) {
			bindings.push({ binding, query_ref: null, column, value: null, status: "refused" });
			continue;
		}
		try {
			const result = await runStructured(app, scopes, record.request);
			const index = result.columns.findIndex(({ name }) => name === column);
			if (index < 0) {
				bindings.push({
					binding,
					query_ref: result.query_ref,
					column,
					value: null,
					status: "refused",
				});
				continue;
			}
			bindings.push({
				binding,
				query_ref: result.query_ref,
				column,
				value: result.rows[0]?.[index] ?? null,
				status: "resolved",
			});
			prose = prose.replaceAll(`stat:${queryRef}#`, `stat:${result.query_ref}#`);
		} catch (error) {
			if (!(error instanceof QueryError)) throw error;
			bindings.push({ binding, query_ref: null, column, value: null, status: "refused" });
		}
	}
	const render: RenderArtifact = {
		schema_version: 1,
		renderer: "native",
		spec: null,
		data_query_ref: null,
		selection_reason: "text panel stat bindings resolved as the viewer",
		forecast_strategy: null,
		bindings,
	};
	const rendered = { ...panel, prose, render };
	return { schema_version: 1, panel: rendered, result: null, render };
}

export async function loadDashboard(
	app: Sql,
	scopes: readonly string[],
	id: string,
): Promise<Record<string, unknown> | null> {
	const row = await readDashboardRow(app, scopes, id);
	if (!row) return null;
	const materialized: MaterializedPanel[] = [];
	for await (const panel of asynchronously(row.payload.panels)) {
		if (!panel.query_ref) {
			materialized.push(
				panel.type === "text"
					? await materializeTextPanel(app, scopes, panel)
					: panel.type === "refusal"
						? nativePanel(panel)
						: unavailablePanel(panel),
			);
			continue;
		}
		const record = await readQueryRecord(app, scopes, panel.query_ref);
		if (!record) {
			materialized.push(unavailablePanel(panel));
			continue;
		}
		try {
			const result = await runStructured(app, scopes, record.request);
			materialized.push(materializePanel(panel, result));
		} catch (error) {
			if (!(error instanceof QueryError)) throw error;
			materialized.push(unavailablePanel(panel));
		}
	}
	return { ...itemEnvelope(row), materialized_panels: materialized };
}

export async function setHomeDashboard(
	writer: Sql,
	principal: Principal,
	id: string,
): Promise<Record<string, unknown>> {
	const rows = await writer<ItemRow[]>`
		select id, title, scope, is_home, created_by, responsible_human, payload, updated_at
		from library_items where id = ${id} and kind = 'artifact'
		  and (properties->>'artifact_type' = 'dashboard' or payload ? 'panels')`;
	const target = rows[0];
	if (!principal.scopes.includes(target.scope))
		throw new DashboardError("dashboard_not_found", "dashboard not found");
	if (
		target.created_by !== principal.id ||
		!(await canMutateScope(writer, principal, target.scope))
	)
		throw new DashboardError("scope_denied", "only the dashboard owner may set it as home");
	await writer.begin(async (tx) => {
		await tx`update library_items set is_home = false
		  where kind = 'artifact'
		    and (properties->>'artifact_type' = 'dashboard' or payload ? 'panels')
		    and created_by = ${principal.id}`;
		await tx`update library_items set is_home = true, updated_at = now() where id = ${id}`;
	});
	return { schema_version: 1, id, is_home: true };
}

const LIBRARY_KINDS = new Set([
	"task",
	"project",
	"doc",
	"artifact",
	"research",
	"fact",
	"decision",
	"how-to",
]);

interface LibraryItemRow {
	id: string;
	entity_id: string;
	kind: string;
	title: string;
	scope: string;
	project: string;
	status: string;
	body_ref: string | null;
	render_mode: string;
	confidence: number | null;
	source_url: string | null;
	properties: Record<string, unknown>;
	version: number;
	tx_from: string | Date;
	created_by: string | null;
	responsible_human: string | null;
	handed_off_to: string | null;
	protection: string;
	updated_at: string | Date;
	rank: number;
}

export interface LibraryReadOptions extends LibraryPageOptions {
	query?: string;
	kind?: string;
	limit?: number;
}

function libraryItemEnvelope(row: LibraryItemRow): Record<string, unknown> {
	return {
		schema_version: 1,
		id: row.id,
		entity_id: row.entity_id,
		kind: row.kind,
		title: row.title,
		scope: row.scope,
		project: row.project,
		status: row.status,
		body_ref: row.body_ref,
		render_mode: row.render_mode,
		confidence: row.confidence,
		source_url: row.source_url,
		properties: row.properties,
		version: row.version,
		tx_from: iso(row.tx_from),
		updated_at: iso(row.updated_at),
		protection: row.protection,
		provenance: {
			created_by_agent: row.created_by,
			responsible_human: row.responsible_human,
			handed_off_to_agent: row.handed_off_to,
		},
		...(row.rank > 0
			? {
					why_matched: {
						lexical_rank: row.rank,
						dense_score: null,
						mode: "lexical",
					},
				}
			: {}),
	};
}

/** Rev3 item/search read. Scope filtering happens in Library RLS before ranking. */
export async function listLibraryItems(
	app: Sql,
	scopes: readonly string[],
	cursorSecret: string,
	opts: LibraryReadOptions = {},
): Promise<Record<string, unknown>> {
	const query = opts.query?.trim().slice(0, 500) || null;
	const kind = opts.kind?.trim() || null;
	if (kind && !LIBRARY_KINDS.has(kind))
		throw new DashboardError("bad_library_kind", "unknown Library item kind");
	const limit = libraryLimit(opts.limit);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ source: "items", query, kind }))
		.digest("base64url");
	const offset = libraryPageOffset(cursorSecret, opts.cursor, fingerprint);
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<LibraryItemRow[]>`
			with ranked as (
			  select i.*,
			    case when ${query}::text is null then 0::real else ts_rank_cd(
			      to_tsvector('english', coalesce(i.title,'') || ' ' || coalesce(i.properties->>'body','')),
			      websearch_to_tsquery('english', ${query}::text)
			    ) end as rank
			  from library_items i
			  where (${kind}::text is null or i.kind = ${kind})
			    and (${query}::text is null or
			      to_tsvector('english', coalesce(i.title,'') || ' ' || coalesce(i.properties->>'body',''))
			        @@ websearch_to_tsquery('english', ${query}::text))
			)
			select id, entity_id, kind, title, scope, project, status, body_ref, render_mode,
			       confidence, source_url, properties, version, tx_from, created_by,
			       responsible_human, handed_off_to, protection, updated_at, rank
			from ranked order by rank desc, tx_from desc, id desc limit ${limit + 1} offset ${offset}`,
	);
	const page = rows.slice(0, limit);
	return {
		schema_version: 1,
		freshness: { source: "library", observed_at: new Date().toISOString(), window_s: 60 },
		search: {
			query,
			mode: query ? "lexical" : null,
			dense_index: "unavailable",
			degraded: Boolean(query),
		},
		items: page.map(libraryItemEnvelope),
		next_cursor:
			rows.length > page.length
				? libraryPageCursor(cursorSecret, offset + page.length, fingerprint)
				: null,
		truncated: rows.length > page.length,
	};
}

/** Scope-filtered fuzzy Library retrieval for the global palette. */
export async function searchLibraryPaletteItems(
	app: Sql,
	scopes: readonly string[],
	query: string,
	limit = 32,
): Promise<Record<string, unknown>> {
	const needle = query.trim().toLocaleLowerCase();
	const escaped = needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
	const subsequence = `%${Array.from(needle)
		.map((character) =>
			character.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"),
		)
		.join("%")}%`;
	const bounded = Math.min(Math.max(1, Math.floor(limit)), 32);
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<LibraryItemRow[]>`
			select i.*, 0::real as rank
			from library_items i
			where lower(concat_ws(' ', i.title, i.kind, i.project, i.status, i.properties->>'body'))
			  like ${subsequence} escape E'\\\\'
			order by
			  (lower(i.title) = ${needle}) desc,
			  (lower(i.title) like ${`${escaped}%`} escape E'\\\\') desc,
			  (position(${needle} in lower(i.title)) > 0) desc,
			  char_length(i.title) asc, i.updated_at desc, i.id desc
			limit ${bounded}`,
	);
	return {
		schema_version: 1,
		freshness: { source: "library", observed_at: new Date().toISOString(), window_s: 60 },
		items: rows.map(libraryItemEnvelope),
		next_cursor: null,
		truncated: false,
	};
}

export async function readLibraryItem(
	app: Sql,
	scopes: readonly string[],
	itemId: string,
): Promise<Record<string, unknown> | null> {
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<LibraryItemRow[]>`
			select id, entity_id, kind, title, scope, project, status, body_ref, render_mode,
			       confidence, source_url, properties, version, tx_from, created_by,
			       responsible_human, handed_off_to, protection, updated_at, 0::real as rank
			from library_items where id = ${itemId}`,
	);
	const row = rows.at(0);
	return row
		? {
				schema_version: 1,
				freshness: { source: "library", observed_at: new Date().toISOString(), window_s: 60 },
				item: libraryItemEnvelope(row),
			}
		: null;
}

export async function readLibraryItemHistory(
	app: Sql,
	scopes: readonly string[],
	itemId: string,
): Promise<Record<string, unknown>> {
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<
			{ version: number; tx_from: string | Date; snapshot: LibraryItemRow }[]
		>`select r.version, r.tx_from, r.snapshot
	  from library_item_revisions r
	  join library_items i on i.id = r.item_id
	  where r.item_id = ${itemId}
	  order by r.version desc`,
	);
	return {
		schema_version: 1,
		freshness: { source: "library-history", observed_at: new Date().toISOString(), window_s: 60 },
		items: rows.map((row) => ({
			version: row.version,
			tx_from: iso(row.tx_from),
			item: libraryItemEnvelope({ ...row.snapshot, rank: 0 }),
		})),
	};
}

const WORK_LIBRARY_STATUSES = new Set(["todo", "doing", "review", "done"]);
const KNOWLEDGE_LIBRARY_STATUSES = new Set([
	"draft",
	"verified-shared",
	"superseded",
	"invalidated",
]);

/**
 * Apply the Library status register write behind the audited named-op plane. A stale version is
 * preserved as an explicit CONFLICT with both candidate values; it never becomes a silent LWW.
 */
export async function updateLibraryItemStatus(
	writer: Sql,
	id: string,
	status: string,
	expectedVersion: number,
): Promise<Record<string, unknown>> {
	return writer.begin(async (tx) => {
		const rows = await tx<
			{
				id: string;
				kind: string;
				status: string;
				version: number;
				properties: Record<string, unknown>;
			}[]
		>`select id, kind, status, version, properties from library_items where id = ${id} for update`;
		const current = rows[0];

		const allowed = current.kind === "task" ? WORK_LIBRARY_STATUSES : KNOWLEDGE_LIBRARY_STATUSES;
		if (!allowed.has(status))
			throw new DashboardError(
				"bad_library_status",
				current.kind === "task"
					? "task items use todo, doing, review, or done"
					: "knowledge items use draft, verified-shared, superseded, or invalidated",
			);
		if (current.version !== expectedVersion) {
			const conflict = {
				values: [current.status, status],
				expected_version: expectedVersion,
				observed_version: current.version,
				observed_at: new Date().toISOString(),
			};
			const updated = await tx<{ version: number }[]>`
				update library_items
				set status = 'CONFLICT',
				    properties = jsonb_set(properties, '{status_conflict}', ${tx.json(conflict)}::jsonb, true),
				    version = version + 1, tx_from = now(), updated_at = now()
				where id = ${id} returning version`;
			return {
				schema_version: 1,
				id,
				status: "CONFLICT",
				version: updated[0].version,
				conflict,
			};
		}
		const updated = await tx<{ version: number; updated_at: string | Date }[]>`
			update library_items
			set status = ${status}, version = version + 1, tx_from = now(), updated_at = now(),
			    properties = properties - 'status_conflict'
			where id = ${id} returning version, updated_at`;
		return {
			schema_version: 1,
			id,
			status,
			version: updated[0].version,
			updated_at: iso(updated[0].updated_at),
		};
	});
}

export async function listLibraryLinks(
	app: Sql,
	scopes: readonly string[],
	cursorSecret: string,
	itemId?: string,
	opts: LibraryPageOptions = {},
): Promise<Record<string, unknown>> {
	const limit = libraryLimit(opts.limit);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ source: "links", itemId: itemId ?? null }))
		.digest("base64url");
	const offset = libraryPageOffset(cursorSecret, opts.cursor, fingerprint);
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<
			{
				from_id: string;
				to_id: string;
				rel_type: string;
				reason: string | null;
				scope: string;
				created_at: string | Date;
			}[]
		>`
			select l.from_id, l.to_id, l.rel_type, l.reason, l.scope, l.created_at
			from library_links l
			join library_items source on source.id = l.from_id
			join library_items target on target.id = l.to_id
			where (${itemId ?? null}::text is null or l.from_id = ${itemId ?? null} or l.to_id = ${itemId ?? null})
			order by l.created_at desc, l.id desc limit ${limit + 1} offset ${offset}`,
	);
	const page = rows.slice(0, limit);
	return {
		schema_version: 1,
		freshness: { source: "library-links", observed_at: new Date().toISOString(), window_s: 60 },
		items: page.map((row) => ({ schema_version: 1, ...row, created_at: iso(row.created_at) })),
		next_cursor:
			rows.length > page.length
				? libraryPageCursor(cursorSecret, offset + page.length, fingerprint)
				: null,
		truncated: rows.length > page.length,
	};
}

export async function listLibraryHolds(
	app: Sql,
	scopes: readonly string[],
	principalId: string,
	cursorSecret: string,
	opts: LibraryPageOptions = {},
): Promise<Record<string, unknown>> {
	const limit = libraryLimit(opts.limit);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ source: "holds", principalId }))
		.digest("base64url");
	const offset = libraryPageOffset(cursorSecret, opts.cursor, fingerprint);
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<
			{ item_id: string; reason: string; scope: string; held_at: string | Date }[]
		>`select item_id, reason, scope, held_at from library_holds
		  where for_principal = ${principalId} order by held_at desc, id desc
		  limit ${limit + 1} offset ${offset}`,
	);
	const page = rows.slice(0, limit);
	return {
		schema_version: 1,
		freshness: { source: "librarian-holds", observed_at: new Date().toISOString(), window_s: 60 },
		items: page.map((row) => ({ schema_version: 1, ...row, held_at: iso(row.held_at) })),
		next_cursor:
			rows.length > page.length
				? libraryPageCursor(cursorSecret, offset + page.length, fingerprint)
				: null,
		truncated: rows.length > page.length,
	};
}

export async function listLibraryCuration(
	app: Sql,
	scopes: readonly string[],
	cursorSecret: string,
	opts: LibraryPageOptions = {},
): Promise<Record<string, unknown>> {
	const limit = libraryLimit(opts.limit);
	const fingerprint = createHash("sha256").update("library:curation").digest("base64url");
	const offset = libraryPageOffset(cursorSecret, opts.cursor, fingerprint);
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<
			{
				id: string;
				item_id: string;
				proposal_type: string;
				reason: string;
				scope: string;
				state: string;
				links_in: number;
				active_task_links: number;
				run_id: string | null;
				proposed_at: string | Date;
			}[]
		>`select id, item_id, proposal_type, reason, scope, state, links_in, active_task_links,
		         run_id, proposed_at, capability, version, sha256, proposed_by, reviewed_by,
		         reviewed_at, review_reason from library_curation
		  where state in ('review', 'proposed', 'under-review') order by proposed_at desc, id desc
		  limit ${limit + 1} offset ${offset}`,
	);
	const page = rows.slice(0, limit);
	return {
		schema_version: 1,
		freshness: {
			source: "librarian-curation",
			observed_at: new Date().toISOString(),
			window_s: null,
		},
		items: page.map((row) => ({ schema_version: 1, ...row, proposed_at: iso(row.proposed_at) })),
		next_cursor:
			rows.length > page.length
				? libraryPageCursor(cursorSecret, offset + page.length, fingerprint)
				: null,
		truncated: rows.length > page.length,
	};
}

/** Fleet capability inventory comes from the operational registry projection, never semantics. */
export async function listLibraryCapabilities(
	app: Sql,
	scopes: readonly string[],
	cursorSecret: string,
	opts: LibraryPageOptions = {},
): Promise<Record<string, unknown>> {
	const limit = libraryLimit(opts.limit);
	const fingerprint = createHash("sha256").update("library:capabilities").digest("base64url");
	const offset = libraryPageOffset(cursorSecret, opts.cursor, fingerprint);
	const rows = await withScopes(
		app,
		scopes,
		async (tx) => tx<
			{
				subject: string;
				scope: string;
				state: Record<string, unknown>;
				observed_at: string | Date;
			}[]
		>`
			select subject, scope, state, observed_at from current_state
			where kind = 'registry' order by subject`,
	);
	const allItems = rows.flatMap((row) => {
		const raw = row.state["provides"] ?? row.state["capabilities"] ?? [];
		const capabilities = Array.isArray(raw)
			? raw.filter((value): value is string => typeof value === "string")
			: typeof raw === "string"
				? raw
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean)
				: [];
		return capabilities.map((capability) => ({
			schema_version: 1,
			capability,
			provider: row.subject,
			scope: row.scope,
			host: typeof row.state["host"] === "string" ? row.state["host"] : null,
			transport: typeof row.state["transport"] === "string" ? row.state["transport"] : null,
			observed_at: iso(row.observed_at),
			fresh: Date.now() - new Date(row.observed_at).getTime() <= 90_000,
		}));
	});
	const page = allItems.slice(offset, offset + limit + 1);
	const items = page.slice(0, limit);
	return {
		schema_version: 1,
		freshness: {
			source: "fleet-tool-registry",
			observed_at: new Date().toISOString(),
			window_s: 90,
		},
		items,
		next_cursor:
			page.length > items.length
				? libraryPageCursor(cursorSecret, offset + items.length, fingerprint)
				: null,
		truncated: page.length > items.length,
	};
}
