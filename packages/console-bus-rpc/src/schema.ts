import { Schema } from "effect";

// The console wire contract, in Effect Schema. This is the single typed source for every frame the
// bus speaks and every command/query call the REST plane accepts — clients decode against these
// schemas instead of JSON.parse + shape guards ("real types, not trust-the-magic").

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

export const BusSeveritySchema = Schema.Union([
	Schema.Literal("debug"),
	Schema.Literal("info"),
	Schema.Literal("warn"),
	Schema.Literal("danger"),
	Schema.Literal("p0"),
]).annotate({ identifier: "BusSeverity" });

export const BusEmissionSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String,
	type: Schema.String,
	ts: Schema.String,
	source: Schema.Struct({
		service: Schema.String,
		host: Schema.optional(Schema.NullOr(Schema.String)),
		agent: Schema.optional(Schema.NullOr(Schema.String)),
	}),
	subject: Schema.String,
	subject_kind: Schema.optional(Schema.NullOr(Schema.String)),
	severity: BusSeveritySchema,
	action: Schema.optional(Schema.NullOr(Schema.String)),
	task_id: Schema.optional(Schema.NullOr(Schema.Number)),
	scope: Schema.String,
	dimensions: Schema.optional(JsonObject),
	measures: Schema.optional(JsonObject),
	links: Schema.optional(Schema.Array(JsonObject)),
	body_ref: Schema.optional(Schema.NullOr(Schema.String)),
	meta: Schema.optional(JsonObject),
}).annotate({ identifier: "BusEmission", title: "Bus emission" });
export type BusEmission = typeof BusEmissionSchema.Type;

// --- client → server -----------------------------------------------------------------------------

export const BusSubscribeFilterSchema = Schema.Struct({
	severity_gte: Schema.optional(Schema.String),
	source_service: Schema.optional(Schema.String),
	subject: Schema.optional(Schema.String),
}).annotate({ identifier: "BusSubscribeFilter" });
export type BusSubscribeFilter = typeof BusSubscribeFilterSchema.Type;

export const BusSubscribeSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	action: Schema.Literal("subscribe"),
	sub_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	pattern: Schema.String,
	filter: Schema.optional(BusSubscribeFilterSchema),
	since: Schema.optional(Schema.Number),
}).annotate({ identifier: "BusSubscribe", title: "Bus subscribe frame" });
export type BusSubscribe = typeof BusSubscribeSchema.Type;

export const BusUnsubscribeSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	action: Schema.Literal("unsubscribe"),
	sub_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}).annotate({ identifier: "BusUnsubscribe", title: "Bus unsubscribe frame" });
export type BusUnsubscribe = typeof BusUnsubscribeSchema.Type;

export const BusClientFrameSchema = Schema.Union([BusSubscribeSchema, BusUnsubscribeSchema]);
export type BusClientFrame = typeof BusClientFrameSchema.Type;

// --- server → client -----------------------------------------------------------------------------

export const BusFrameErrorSchema = Schema.Struct({
	code: Schema.String,
	message: Schema.String,
	retryable: Schema.Boolean,
}).annotate({ identifier: "BusFrameError" });
export type BusFrameError = typeof BusFrameErrorSchema.Type;

export const BusAckFrameSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	kind: Schema.Literal("ack"),
	sub_id: Schema.String,
	replay_through_seq: Schema.Number,
	error: Schema.optional(BusFrameErrorSchema),
}).annotate({ identifier: "BusAckFrame", title: "Subscription acknowledgement" });
export type BusAckFrame = typeof BusAckFrameSchema.Type;

export const BusEventFrameSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	kind: Schema.Literal("event"),
	sub_id: Schema.String,
	seq: Schema.Number,
	emission: BusEmissionSchema,
}).annotate({ identifier: "BusEventFrame", title: "Replayed or live bus event" });
export type BusEventFrame = typeof BusEventFrameSchema.Type;

export const BusResyncFrameSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	kind: Schema.Literal("resync_required"),
	sub_id: Schema.String,
	oldest_seq: Schema.Number,
	message: Schema.optional(Schema.String),
}).annotate({
	identifier: "BusResyncFrame",
	title: "Subscription dropped — re-subscribe from oldest_seq",
});
export type BusResyncFrame = typeof BusResyncFrameSchema.Type;

export const BusGapFrameSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	kind: Schema.Literal("gap"),
	sub_id: Schema.String,
	from_seq: Schema.Number,
	to_seq: Schema.Number,
	reason: Schema.String,
}).annotate({ identifier: "BusGapFrame", title: "Backpressure gap — heal via since" });
export type BusGapFrame = typeof BusGapFrameSchema.Type;

export const BusHeartbeatFrameSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	kind: Schema.Literal("heartbeat"),
	ts: Schema.String,
	seq_head: Schema.Number,
	ingest: Schema.NullOr(Schema.Record(Schema.String, Schema.Number)),
}).annotate({ identifier: "BusHeartbeatFrame", title: "Connection heartbeat with ingest lag" });
export type BusHeartbeatFrame = typeof BusHeartbeatFrameSchema.Type;

export const BusServerFrameSchema = Schema.Union([
	BusAckFrameSchema,
	BusEventFrameSchema,
	BusResyncFrameSchema,
	BusGapFrameSchema,
	BusHeartbeatFrameSchema,
]);
export type BusServerFrame = typeof BusServerFrameSchema.Type;

// --- command / query planes ----------------------------------------------------------------------

export const OpCallSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	id: Schema.String,
	op: Schema.String,
	args: JsonObject,
	task_id: Schema.optional(Schema.NullOr(Schema.Number)),
	reason: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000)))),
	dry_run: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "OpCall", title: "Named operation call" });
export type OpCall = typeof OpCallSchema.Type;

export const OpResultSchema = Schema.Struct({
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
export type OpResult = typeof OpResultSchema.Type;

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
	sql: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "QueryRequest", title: "Structured or read-only SQL query" });
export type QueryRequest = typeof QueryRequestSchema.Type;

export const QueryResultSchema = Schema.Struct({
	schema_version: Schema.Literal(1),
	columns: Schema.Array(JsonObject),
	rows: Schema.Array(Schema.Array(Schema.Unknown)),
	row_count: Schema.Number,
	execution_ms: Schema.optional(Schema.NullOr(Schema.Number)),
	freshness: JsonObject,
	query_ref: Schema.String,
	truncated: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "QueryResult", title: "Scoped query result" });
export type QueryResult = typeof QueryResultSchema.Type;
