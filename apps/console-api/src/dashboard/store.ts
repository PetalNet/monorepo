import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
	return principal.scopes.includes(personal) ? personal : ([...principal.scopes].sort()[0] ?? null);
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
	for (const raw of input.panels as PanelSpecV2[]) {
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
			for (const match of statBindings(raw.prose)) {
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
		from items_min where id = ${id}`;
	return rows[0] ?? null;
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
	if (existing[0]) {
		if (existing[0].request_hash !== hash)
			throw new DashboardError("id_reused", "mutation id was already used with a different body");
		const item = await dashboardById(db.writer, existing[0].dashboard_id);
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
		if (!claimed[0]) {
			const raced = await tx<MutationRow[]>`
				select request_hash, dashboard_id from dashboard_mutations
				where principal_id = ${principal.id} and request_id = ${input.id}`;
			if (!raced[0] || raced[0].request_hash !== hash)
				throw new DashboardError("id_reused", "mutation id was already used with a different body");
			const item = await dashboardById(tx, raced[0].dashboard_id);
			if (!item) throw new Error("dashboard mutation points to a missing item");
			if (item.scope !== scope || !principal.scopes.includes(item.scope))
				throw new DashboardError("scope_denied", "dashboard scope is not visible to the caller");
			return itemEnvelope(item);
		}
		const rows = await tx<ItemRow[]>`
			insert into items_min (id, kind, title, scope, created_by, responsible_human, payload)
			values (${id}, 'artifact', ${input.title}, ${scope}, ${principal.id}, ${principal.kind === "human" ? principal.id : null}, ${tx.json(payload as never)})
			returning id, title, scope, is_home, created_by, responsible_human, payload, updated_at`;
		return itemEnvelope(rows[0]!);
	});
}

function iso(value: string | Date): string {
	return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function itemEnvelope(row: ItemRow): Record<string, unknown> {
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
		payload: row.payload,
	};
}

export async function listDashboards(
	app: Sql,
	scopes: readonly string[],
	cursorSecret: string,
	opts: { limit?: number; cursor?: string } = {},
): Promise<Record<string, unknown>> {
	const rawLimit = Number(opts.limit ?? 200);
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
			from items_min where kind = 'artifact' and payload ? 'panels'
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

async function readDashboardRow(
	app: Sql,
	scopes: readonly string[],
	id: string,
): Promise<ItemRow | null> {
	return withScopes(app, scopes, async (tx) => {
		const rows = await tx<ItemRow[]>`
			select id, title, scope, is_home, created_by, responsible_human, payload, updated_at
			from items_min where id = ${id} and kind = 'artifact' and payload ? 'panels'`;
		return rows[0] ?? null;
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

async function materializeTextPanel(
	app: Sql,
	scopes: readonly string[],
	panel: PanelSpecV2,
): Promise<MaterializedPanel> {
	if (typeof panel.prose !== "string" || !panel.prose.includes("{{stat:"))
		return nativePanel(panel);
	const bindings: NonNullable<RenderArtifact["bindings"]> = [];
	let prose = panel.prose;
	for (const match of statBindings(panel.prose)) {
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
	for (const panel of row.payload.panels) {
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
