import { Effect, Schema } from "effect";

import { formatUnknown } from "#format";

import { resolveScopes, sha256, type Principal } from "../auth/principal.ts";
import {
	listLibraryCuration,
	listLibraryItems,
	loadDashboard,
	materializeTextPanel,
	readLibraryItem,
} from "../dashboard/store.ts";
import type { Db, Sql } from "../db/pool.ts";
import { scrubUnknown } from "../ingest/scrubber.ts";
import { readQueryRecord } from "../query/history.ts";
import { runStructured, type QueryRequest } from "../query/structured.ts";
import { materializePanel } from "../render/engine.ts";
import type { PanelSpecV2 } from "../render/types.ts";
import {
	dashboardSaveSchema,
	renderRequestSchema,
	selectedMarkSchema,
} from "../render/validation.ts";
import { rejectUnknownKeys } from "../schema-conventions.ts";

const windowSchema = Schema.Struct({
	ops: Schema.Array(
		// Ops tolerate extra keys (zod `.loose()` parity): the rest record preserves unknown keys.
		Schema.StructWithRest(
			Schema.Struct({
				verb: Schema.Literals(["place", "size", "group", "highlight", "clear", "pin"]),
				panel_index: Schema.optional(
					Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 59 })),
				),
				layout: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
			}),
			[Schema.Record(Schema.String, Schema.Unknown)],
		),
	).check(Schema.isMaxLength(100)),
}).annotate(rejectUnknownKeys);

const textSchema = Schema.Struct({
	prose: Schema.String.check(Schema.isMaxLength(65_536)),
	bindings: Schema.Array(
		Schema.Struct({
			query_ref: Schema.String.check(Schema.isMaxLength(100)),
			column: Schema.String.check(Schema.isMaxLength(128)),
			agg: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
		}).annotate(rejectUnknownKeys),
	)
		.check(Schema.isMaxLength(100))
		.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
}).annotate(rejectUnknownKeys);

const dashboardToolSchema = Schema.Union([
	Schema.Struct({ action: Schema.Literal("save"), dashboard: dashboardSaveSchema }).annotate(
		rejectUnknownKeys,
	),
	Schema.Struct({
		action: Schema.Literal("load"),
		id: Schema.String.check(Schema.isMaxLength(100)),
	}).annotate(rejectUnknownKeys),
	Schema.Struct({
		action: Schema.Literal("set_home"),
		id: Schema.String.check(Schema.isMaxLength(100)),
		request_id: Schema.String.check(Schema.isUUID()),
	}).annotate(rejectUnknownKeys),
]);

const contextSchema = Schema.Struct({
	payload: Schema.Struct({
		...selectedMarkSchema.fields,
		value: Schema.Unknown.check(
			Schema.makeFilter((value) => value !== undefined || "value is required"),
		),
	}).annotate(rejectUnknownKeys),
}).annotate(rejectUnknownKeys);

const librarySurfaceLimit = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: 100 }),
).pipe(Schema.withDecodingDefault(Effect.succeed(20)));

const librarySurfaceSchema = Schema.Union([
	Schema.Struct({
		action: Schema.Literal("view"),
		view: Schema.Literals(["desk", "graph", "kanban", "table"]),
	}).annotate(rejectUnknownKeys),
	Schema.Struct({
		action: Schema.Literal("search"),
		query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
		kind: Schema.optional(
			Schema.Literals([
				"task",
				"project",
				"doc",
				"artifact",
				"research",
				"fact",
				"decision",
				"how-to",
			]),
		),
		limit: librarySurfaceLimit,
	}).annotate(rejectUnknownKeys),
	Schema.Struct({
		action: Schema.Literal("open"),
		item_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	}).annotate(rejectUnknownKeys),
	Schema.Struct({
		action: Schema.Literal("curation"),
		limit: librarySurfaceLimit,
	}).annotate(rejectUnknownKeys),
]);

const TOOLS = [
	{
		name: "stats.query",
		description: "Run a caller-scoped structured statistics query.",
		inputSchema: {
			type: "object",
			required: ["schema_version", "mode", "from"],
			properties: {
				schema_version: { const: 1 },
				mode: { const: "structured" },
				from: { type: "string" },
			},
			additionalProperties: true,
		},
	},
	{
		name: "viz.render",
		description: "Materialize a renderer-agnostic visualization.",
		inputSchema: {
			type: "object",
			required: ["query_ref", "panel"],
			properties: { query_ref: { type: "string" }, panel: { type: "object" } },
			additionalProperties: false,
		},
	},
	{
		name: "text.surface",
		description: "Create prose with proved inline statistic bindings.",
		inputSchema: {
			type: "object",
			required: ["prose"],
			properties: { prose: { type: "string" }, bindings: { type: "array" } },
			additionalProperties: false,
		},
	},
	{
		name: "window.arrange",
		description: "Arrange the caller's current assistant window.",
		inputSchema: {
			type: "object",
			required: ["ops"],
			properties: { ops: { type: "array", maxItems: 100 } },
			additionalProperties: false,
		},
	},
	{
		name: "dashboard.manage",
		description: "Save, load, or set the caller's home dashboard.",
		inputSchema: {
			type: "object",
			required: ["action"],
			properties: {
				action: { enum: ["save", "load", "set_home"] },
				id: { type: "string" },
				request_id: { type: "string", format: "uuid" },
				dashboard: { type: "object" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "context.receive",
		description: "Record selected UI context as the latest session context.",
		inputSchema: {
			type: "object",
			required: ["payload"],
			properties: {
				payload: {
					type: "object",
					required: ["element_kind", "value"],
					properties: {
						element_kind: { type: "string", minLength: 1, maxLength: 100 },
						field: { type: "string", maxLength: 200 },
						value: {},
						datum: { type: "object" },
						query_ref: { type: "string", maxLength: 100 },
						entity_ref: { type: "string", maxLength: 500 },
					},
					additionalProperties: false,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "library.surface",
		description:
			"Drive the caller's Library surface: switch a browse view, run scope-filtered search, open a visible item, or show reviewable curation. Returns a library UI intent for the console.",
		inputSchema: {
			type: "object",
			required: ["action"],
			properties: {
				action: { enum: ["view", "search", "open", "curation"] },
				view: { enum: ["desk", "graph", "kanban", "table"] },
				query: { type: "string", minLength: 1, maxLength: 500 },
				kind: {
					enum: ["task", "project", "doc", "artifact", "research", "fact", "decision", "how-to"],
				},
				limit: { type: "integer", minimum: 1, maximum: 100 },
				item_id: { type: "string", minLength: 1, maxLength: 256 },
			},
			additionalProperties: false,
		},
	},
] as const;

interface SessionPrincipalRow {
	principal_id: string;
	principal_kind: Principal["kind"];
	tiers: string[];
	lanes: string[];
	auth_source: string;
	auth_session_id: string | null;
}

export async function resolveAssistantToolPrincipal(
	admin: Sql,
	token: string,
	resolveBetterAuthSession?: (sessionId: string) => Promise<Principal | null>,
): Promise<Principal | null> {
	const rows = await admin<SessionPrincipalRow[]>`
		select s.principal_id, s.principal_kind, s.tiers, s.lanes, s.auth_source, s.auth_session_id
		from assistant_tool_tokens t join assistant_sessions s on s.principal_id = t.principal_id
		where t.token_sha256 = ${sha256(token)} and t.expires_at > now()`;
	const row = rows.at(0);
	if (!row) return null;

	if (row.auth_source === "better-auth") {
		if (!row.auth_session_id || !resolveBetterAuthSession) return null;
		const current = await resolveBetterAuthSession(row.auth_session_id);
		if (!current || current.id !== row.principal_id || current.kind !== row.principal_kind)
			return null;
		return current;
	}
	const current = await admin<{ kind: Principal["kind"]; tiers: string[]; lanes: string[] }[]>`
		select kind, tiers, lanes from api_tokens where subject = ${row.principal_id}
		  and revoked_at is null and kind = ${row.principal_kind} and tiers = ${admin.json(row.tiers)}
		  and lanes = ${admin.json(row.lanes)} limit 1`;
	if (!current.at(0)) return null;

	const { scopes, zookie } = await resolveScopes(admin, row.principal_id, row.tiers);
	return {
		kind: row.principal_kind,
		id: row.principal_id,
		tiers: row.tiers,
		lanes: row.lanes,
		scopes,
		zookie,
	};
}

async function callTool(
	services: AssistantToolServices,
	principal: Principal,
	name: string,
	args: unknown,
): Promise<unknown> {
	const { db } = services;
	if (name === "stats.query") return runStructured(db.app, principal.scopes, args as QueryRequest);
	if (name === "viz.render") {
		const parsed = Schema.decodeUnknownSync(renderRequestSchema)(args);
		const record = await readQueryRecord(db.app, principal.scopes, parsed.query_ref);
		if (!record) throw new Error("query_not_found");
		return materializePanel(
			parsed.panel as PanelSpecV2,
			await runStructured(db.app, principal.scopes, record.request),
		);
	}
	if (name === "text.surface") {
		const parsed = Schema.decodeUnknownSync(textSchema)(args);
		const bindings = parsed.bindings
			.map(
				({ query_ref, column, agg }) => `{{stat:${query_ref}#${column}${agg ? `[${agg}]` : ""}}}`,
			)
			.join("\n");
		return materializeTextPanel(db.app, principal.scopes, {
			schema_version: 2,
			type: "text",
			title: "Assistant note",
			prose: bindings ? `${parsed.prose}\n${bindings}` : parsed.prose,
		});
	}
	if (name === "window.arrange") {
		const parsed = Schema.decodeUnknownSync(windowSchema)(args);
		return services.executeMutation(principal, "window.arrange", { ops: parsed.ops });
	}
	if (name === "dashboard.manage") {
		const parsed = Schema.decodeUnknownSync(dashboardToolSchema)(args);
		if (parsed.action === "save") {
			return services.executeMutation(principal, "dashboard.save", parsed.dashboard);
		}
		if (parsed.action === "load") return loadDashboard(db.app, principal.scopes, parsed.id);
		return services.executeMutation(
			principal,
			"dashboard.set_home",
			{ id: parsed.id },
			parsed.request_id,
		);
	}
	if (name === "context.receive") {
		const parsed = Schema.decodeUnknownSync(contextSchema)(args);
		if (!scrubUnknown(parsed.payload, "context.payload").ok) throw new Error("secret_detected");
		return services.executeMutation(principal, "context.receive", { payload: parsed.payload });
	}
	if (name === "library.surface") {
		const parsed = Schema.decodeUnknownSync(librarySurfaceSchema)(args);
		let intent: Record<string, unknown>;
		let data: Record<string, unknown> | null = null;
		if (parsed.action === "view") intent = { view: parsed.view };
		else if (parsed.action === "search") {
			intent = { view: "table", query: parsed.query };
			data = await listLibraryItems(db.app, principal.scopes, services.cursorSecret, {
				query: parsed.query,
				...(parsed.kind ? { kind: parsed.kind } : {}),
				limit: parsed.limit,
			});
		} else if (parsed.action === "open") {
			const item = await readLibraryItem(db.app, principal.scopes, parsed.item_id);
			if (!item) throw new Error("library_item_not_found");
			intent = { view: "table", item_id: parsed.item_id };
			data = item;
		} else {
			intent = { view: "desk", focus: "curation" };
			data = await listLibraryCuration(db.app, principal.scopes, services.cursorSecret, {
				limit: parsed.limit,
			});
		}
		await db.writer`
			update assistant_sessions
			set window_layout = jsonb_set(window_layout, '{library}', ${db.writer.json(intent)}::jsonb, true),
			    updated_at = now()
			where principal_id = ${principal.id}`;
		return { schema_version: 1, surface: "library", intent, data };
	}
	throw new Error("unknown_tool");
}

export async function handleAssistantMcp(
	services: AssistantToolServices,
	principal: Principal,
	raw: unknown,
): Promise<Record<string, unknown>> {
	const request =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown })
			: null;
	const id = request?.id ?? null;
	if (request?.jsonrpc !== "2.0" || typeof request.method !== "string")
		return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
	if (request.method === "initialize")
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "lab-console-dashboard", version: "1.0.0" },
			},
		};
	if (request.method === "tools/list")
		return {
			jsonrpc: "2.0",
			id,
			result: { tools: TOOLS },
		};
	if (request.method === "tools/call") {
		const params =
			request.params && typeof request.params === "object" && !Array.isArray(request.params)
				? (request.params as { name?: unknown; arguments?: unknown })
				: {};
		try {
			const result = await callTool(
				services,
				principal,
				formatUnknown(params.name ?? ""),
				params.arguments,
			);
			const response: Record<string, unknown> = {
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: JSON.stringify(result) }],
				},
			};
			if (result !== null && typeof result === "object")
				(response["result"] as Record<string, unknown>)["structuredContent"] = result;
			return response;
		} catch (error) {
			const code =
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				typeof error.code === "string"
					? error.code
					: null;
			services.captureException(error);
			const knownMessages: Record<string, string> = {
				invalid_args: "Tool arguments are invalid",
				bad_op_call: "Tool operation request is invalid",
				lane_denied: "The required lane is not available",
				scope_denied: "The requested target is not authorized",
				rate_limited: "Tool call rate limit exceeded",
				tracker_unavailable: "The proposal tracker is unavailable",
				secret_detected: "The payload contains restricted material",
				dashboard_not_found: "Dashboard not found",
				executor_unreachable: "The operation executor is unavailable",
				audit_unavailable: "The operation audit log is unavailable",
				op_failed: "The operation failed",
			};
			const publicCode = code && knownMessages[code] ? code : "tool_failed";
			const message = knownMessages[publicCode] ?? "Tool call failed";
			return {
				jsonrpc: "2.0",
				id,
				result: {
					isError: true,
					content: [{ type: "text", text: `${publicCode}: ${message}` }],
				},
			};
		}
	}
	return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

export interface AssistantToolServices {
	readonly db: Db;
	readonly cursorSecret: string;
	readonly executeMutation: (
		principal: Principal,
		op: string,
		args: Record<string, unknown>,
		requestId?: string,
	) => Promise<Record<string, unknown>>;
	readonly captureException: (error: unknown) => void;
}
