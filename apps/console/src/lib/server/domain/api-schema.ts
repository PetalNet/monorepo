import { Schema } from "effect";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const JsonValue = Schema.Unknown;
const NullableString = Schema.NullOr(Schema.String);

const EmissionSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String,
	type: Schema.String,
	ts: Schema.String,
	source: Schema.Struct({
		service: Schema.String,
		host: Schema.optional(NullableString),
		agent: Schema.optional(NullableString),
	}),
	subject: Schema.String,
	subject_kind: Schema.optional(NullableString),
	severity: Schema.Union([
		Schema.Literal("debug"),
		Schema.Literal("info"),
		Schema.Literal("warn"),
		Schema.Literal("danger"),
		Schema.Literal("p0"),
	]),
	action: Schema.optional(NullableString),
	task_id: Schema.optional(Schema.NullOr(Schema.Number)),
	scope: Schema.String,
	dimensions: Schema.optional(JsonObject),
	measures: Schema.optional(JsonObject),
	links: Schema.optional(Schema.Array(JsonObject)),
	body_ref: Schema.optional(NullableString),
	meta: Schema.optional(JsonObject),
}).annotate({ identifier: "Emission", title: "Bus emission" });

export const OpCallSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String,
	op: Schema.String,
	args: JsonObject,
	task_id: Schema.optional(Schema.NullOr(Schema.Number)),
	reason: Schema.optional(NullableString),
	dry_run: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "OpCall", title: "Named operation call" });

const OpResultSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	in_reply_to: Schema.String,
	ok: Schema.Boolean,
	status: Schema.optional(
		Schema.NullOr(Schema.Union([Schema.Literal("applied"), Schema.Literal("accepted")])),
	),
	result: Schema.optional(Schema.NullOr(JsonObject)),
	error: Schema.optional(Schema.NullOr(JsonObject)),
	audit_seq: Schema.optional(Schema.NullOr(Schema.Number)),
	executor: Schema.optional(Schema.NullOr(JsonObject)),
	undo: Schema.optional(Schema.NullOr(JsonObject)),
}).annotate({ identifier: "OpResult", title: "Named operation result" });

export const QueryRequestSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	mode: Schema.Union([Schema.Literal("structured"), Schema.Literal("sql")]),
	from: Schema.optional(Schema.String),
	select: Schema.optional(Schema.Array(JsonObject)),
	where: Schema.optional(JsonObject),
	group_by: Schema.optional(Schema.Array(Schema.String)),
	time: Schema.optional(Schema.NullOr(JsonObject)),
	order: Schema.optional(Schema.NullOr(Schema.Array(JsonObject))),
	limit: Schema.optional(Schema.NullOr(Schema.Number)),
	sql: Schema.optional(NullableString),
}).annotate({ identifier: "QueryRequest", title: "Structured or read-only SQL query" });

const QueryResultSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	columns: Schema.Array(JsonObject),
	rows: Schema.Array(Schema.Array(JsonValue)),
	row_count: Schema.Number,
	execution_ms: Schema.optional(Schema.NullOr(Schema.Number)),
	freshness: JsonObject,
	query_ref: Schema.String,
	truncated: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "QueryResult", title: "Scoped query result" });

const AttentionItemSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String,
	grade: Schema.String,
	source: Schema.String,
	subject: Schema.String,
	summary: Schema.String,
	ts: Schema.String,
	scope: Schema.String,
	lane: Schema.optional(Schema.String),
}).annotate({ identifier: "AttentionItem", title: "Attention item" });

const AttentionEnvelopeSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	freshness: JsonObject,
	items: Schema.Array(AttentionItemSchema),
	next_cursor: Schema.NullOr(Schema.String),
	truncated: Schema.Boolean,
}).annotate({ identifier: "AttentionEnvelope", title: "Attention envelope" });

const EmitResultSchema = Schema.Struct({
	ok: Schema.Boolean,
	seq: Schema.optional(Schema.Number),
	duplicate: Schema.optional(Schema.Boolean),
	code: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
}).annotate({ identifier: "EmitResult", title: "Emission acknowledgement" });

const McpRequestSchema = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	id: Schema.optional(JsonValue),
	method: Schema.String,
	params: Schema.optional(JsonObject),
}).annotate({ identifier: "McpRequest", title: "MCP JSON-RPC request" });

const McpResponseSchema = JsonObject.annotate({
	identifier: "McpResponse",
	title: "MCP JSON-RPC response",
});

export const apiSchema = {
	components: {
		AttentionEnvelope: AttentionEnvelopeSchema,
		AttentionItem: AttentionItemSchema,
		Emission: EmissionSchema,
		EmitResult: EmitResultSchema,
		McpRequest: McpRequestSchema,
		McpResponse: McpResponseSchema,
		OpCall: OpCallSchema,
		OpResult: OpResultSchema,
		QueryRequest: QueryRequestSchema,
		QueryResult: QueryResultSchema,
	},
	operations: [
		{ method: "post", path: "/query", operationId: "runStructuredQuery", request: "QueryRequest", response: "QueryResult", description: "Scoped query result" },
		{ method: "post", path: "/op", operationId: "executeNamedOperation", request: "OpCall", response: "OpResult", description: "Operation receipt" },
		{ method: "get", path: "/attention", operationId: "readAttention", response: "AttentionEnvelope", description: "Attention envelope" },
		{ method: "post", path: "/bus/emit", operationId: "emitBusEvent", request: "Emission", response: "EmitResult", description: "Emission acknowledgement" },
		{ method: "post", path: "/mcp", operationId: "consoleMcp", request: "McpRequest", response: "McpResponse", description: "MCP JSON-RPC response" },
	] as const,
} as const;
