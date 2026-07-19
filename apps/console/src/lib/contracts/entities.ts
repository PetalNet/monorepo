// The console's server->client contract entities as Effect Schemas — the single source of truth
// that replaced the generated JSON-Schema mirror (docs/contracts/schemas/**, rewrite Phase 4).
// `$lib/api/types` derives its public types from these schemas and `validateContract` decodes
// against them; the domain test-suite asserts live API responses with them.
//
// Transcription rules (from the retired JSON Schemas, kept at least as constraining for every
// asserted field): `additionalProperties: true` becomes an open struct (a rest record keeps the
// `[key: string]: unknown` shape and makes unknown keys pass-through); `additionalProperties:
// false` becomes a strict struct (`rejectUnknownKeys`); `format: date-time`/`uuid` and `pattern`
// keep the exact regexes the server-side JSON validator enforced.
import { Schema } from "effect";

import { ISO_DATETIME_OFFSET_RE, rejectUnknownKeys, UUID_RE } from "./schema-conventions.ts";

const JsonRest = Schema.Record(Schema.String, Schema.Unknown);
const openStruct = <const F extends Schema.Struct.Fields>(fields: F) =>
	Schema.StructWithRest(Schema.Struct(fields), [JsonRest]);
const strictStruct = <const F extends Schema.Struct.Fields>(fields: F) =>
	Schema.Struct(fields).annotate(rejectUnknownKeys);

const DateTimeString = Schema.String.check(Schema.isPattern(ISO_DATETIME_OFFSET_RE));
const UuidString = Schema.String.check(Schema.isPattern(UUID_RE));
const NullableString = Schema.NullOr(Schema.String);
const NullableDateTime = Schema.NullOr(DateTimeString);
const NullableInt = Schema.NullOr(Schema.Number.check(Schema.isInt()));
const NullableNumber = Schema.NullOr(Schema.Number);
const Int = Schema.Number.check(Schema.isInt());
const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const Handle = Schema.String.check(Schema.isPattern(HANDLE_RE));
const PRINCIPAL_SCOPE_RE =
	/^(user:[a-z0-9._-]+|agent:[a-z0-9._-]+|project:[a-z0-9._-]+|fleet|restricted:[a-z0-9._-]+|item:.+)$/;
const EMISSION_SCOPE_RE =
	/^(user:[a-z0-9._-]+|agent:[a-z0-9._-]+|project:[a-z0-9._-]+|fleet|restricted:[a-z0-9._-]+)$/;

// --- shared closed enums -------------------------------------------------------------------------

export const LaneSchema = Schema.Literals(["viewer", "editor", "operator", "admin", "term_admin"]);
export const SignalSeveritySchema = Schema.Literals(["debug", "info", "warn", "danger", "p0"]);
export const AttentionGradeSchema = Schema.Literals(["p0", "blocker", "review", "artifact"]);
export const BudgetLightColorSchema = Schema.Literals(["green", "yellow", "red"]);
export const TaskStatusSchema = Schema.Literals([
	"inbox",
	"todo",
	"doing",
	"blocked",
	"review",
	"done",
	"dropped",
]);

const SubjectKindSchema = Schema.Literals([
	"agent",
	"host",
	"service",
	"task",
	"card",
	"item",
	"user",
	"session",
	"other",
]);

// --- envelopes and queries -----------------------------------------------------------------------

/** The shared typed-read envelope (`GET /api/v1/<entity>`); `items` is refined per endpoint. */
export const ReadEnvelopeSchema = openStruct({
	schema_version: Schema.Literal(1),
	freshness: openStruct({
		source: Schema.String,
		observed_at: DateTimeString,
		window_s: Schema.optional(NullableNumber),
	}),
	items: Schema.Array(Schema.Unknown),
	next_cursor: NullableString,
	truncated: Schema.Boolean,
});

/** `stats.query` pinned to structured mode (`from` required), as the UI builds queries. */
export const StructuredQuerySchema = strictStruct({
	schema_version: Schema.Literal(1),
	mode: Schema.Literal("structured"),
	from: Schema.String.check(Schema.isMaxLength(128)),
	select: Schema.optional(
		Schema.Array(
			strictStruct({
				field: Schema.String.check(Schema.isMaxLength(128)),
				agg: Schema.optional(
					Schema.NullOr(
						Schema.Literals([
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
							"rate",
						]),
					),
				),
				as: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
			}),
		).check(Schema.isMaxLength(64)),
	),
	where: Schema.optional(JsonRest.check(Schema.isMaxProperties(32))),
	group_by: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(16))),
	time: Schema.optional(
		Schema.NullOr(
			strictStruct({
				from: Schema.optional(Schema.String),
				to: Schema.optional(NullableString),
				bucket: Schema.optional(
					Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9]+(s|m|h|d)$/))),
				),
				fill: Schema.optional(Schema.NullOr(Schema.Literals(["none", "null", "zero", "previous"]))),
				coverage: Schema.optional(Schema.Boolean),
			}),
		),
	),
	order: Schema.optional(
		Schema.NullOr(
			Schema.Array(
				strictStruct({
					field: Schema.String,
					dir: Schema.Literals(["asc", "desc"]),
				}),
			).check(Schema.isMaxLength(8)),
		),
	),
	limit: Schema.optional(
		Schema.NullOr(Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))),
	),
	sql: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(65_536)))),
});

// --- principals ----------------------------------------------------------------------------------

const principalFields = {
	schema_version: Schema.Literal(1),
	kind: Schema.Literals(["human", "agent", "system"]),
	id: Schema.String,
	tiers: Schema.Array(Schema.String).check(Schema.isUnique()),
	lanes: Schema.Array(Schema.String).check(Schema.isUnique()),
	scopes: Schema.Array(Schema.String.check(Schema.isPattern(PRINCIPAL_SCOPE_RE))).check(
		Schema.isUnique(),
	),
	zookie: Schema.String,
} as const;

const PrincipalSchema = openStruct(principalFields);

export const MeSchema = openStruct({
	...principalFields,
	display_name: Schema.optional(NullableString),
	grant_name: Schema.optional(NullableString),
});

// --- availability --------------------------------------------------------------------------------

export const AvailabilitySnapshotSchema = openStruct({
	schema_version: Schema.Literal(1),
	freshness: strictStruct({
		source: Schema.Literal("lake"),
		observed_at: NullableDateTime,
		window_s: PositiveInt,
	}),
	probe_runner: NullableString,
	items: Schema.Array(
		openStruct({
			subject: Schema.String,
			service: Schema.String,
			host: NullableString,
			state: Schema.Literals(["up", "degraded", "down"]),
			p50_latency_ms: Schema.NullOr(NonNegativeNumber),
			p95_latency_ms: Schema.NullOr(NonNegativeNumber),
			degraded_threshold_ms: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
			uptime_pct: Schema.NullOr(
				Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
			),
			coverage_pct: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
			window_s: PositiveInt,
			cadence_s: PositiveInt,
			observed_probes: NonNegativeInt,
			expected_probes: PositiveInt,
			invalid_probes: NonNegativeInt,
			source_error: NullableString,
			last_probe_at: NullableDateTime,
			outage_since: NullableDateTime,
			largest_gap: Schema.NullOr(strictStruct({ from: DateTimeString, to: DateTimeString })),
			points: Schema.Array(
				strictStruct({
					ts: DateTimeString,
					ok: Schema.Boolean,
					latency_ms: Schema.NullOr(NonNegativeNumber),
				}),
			).check(Schema.isMaxLength(60)),
		}),
	),
});

// --- fleet / capacity ----------------------------------------------------------------------------

export const FleetItemSchema = openStruct({
	handle: Handle,
	host: Schema.optional(NullableString),
	event: Schema.optional(Schema.Literals(["session_start", "pre_tool", "post_tool", "stop"])),
	status: Schema.Literals(["alive", "working", "idle"]),
	current_tool: Schema.optional(NullableString),
	task_id: Schema.optional(NullableInt),
	session_id: Schema.optional(NullableString),
	started_at: Schema.optional(DateTimeString),
	updated_at: DateTimeString,
	observed_at: DateTimeString,
});

export const RegistryItemSchema = openStruct({
	handle: Handle,
	provides: Schema.Array(Schema.String),
	free_slots: NonNegativeInt,
	host: Schema.optional(NullableString),
	last_seen_epoch: Int,
});

export const WorkerItemSchema = openStruct({
	handle: Handle,
	host: Schema.String,
	label: Schema.String,
	started_at: DateTimeString,
	updated_at: DateTimeString,
	last_tool: Schema.optional(NullableString),
	tokens_spent: Schema.optional(NullableNumber),
});

// --- box updates ---------------------------------------------------------------------------------

export const BoxUpdateItemSchema = openStruct({
	box_id: Schema.String,
	hostname: Schema.String,
	os_family: Schema.optional(NullableString),
	os_version: Schema.optional(NullableString),
	source_tool: Schema.String,
	agent_vs_agentless: Schema.Literals(["agent", "agentless"]),
	pending_updates_count: Schema.optional(Schema.NullOr(NonNegativeInt)),
	security_critical_count: Schema.optional(Schema.NullOr(NonNegativeInt)),
	vuln_count: Schema.optional(Schema.NullOr(NonNegativeInt)),
	reboot_required: Schema.optional(Schema.NullOr(Schema.Literals([0, 1]))),
	last_checked_at: Schema.optional(NullableDateTime),
	last_applied_at: Schema.optional(NullableDateTime),
	update_channel: Schema.optional(NullableString),
	apply_mode: Schema.optional(
		Schema.NullOr(Schema.Literals(["auto", "staged-approval", "manual-notify-only"])),
	),
	status: Schema.Literals(["up_to_date", "updates_pending", "updates_overdue", "error_collecting"]),
	raw_ref: Schema.optional(NullableString),
	updated_at: DateTimeString,
});

export const BoxUpdateRawSchema = openStruct({
	box_id: Schema.String,
	packages: Schema.Array(
		openStruct({
			name: Schema.String,
			from: Schema.optional(Schema.String),
			to: Schema.optional(Schema.String),
			security: Schema.Boolean,
		}),
	),
	vulns: Schema.Array(
		openStruct({
			cve_id: Schema.String,
			severity: Schema.Literals(["critical", "high", "moderate", "low"]),
			package: Schema.String,
			fixed_in: Schema.optional(NullableString),
		}),
	),
	collected_at: DateTimeString,
});

export const UpdateApprovalSchema = strictStruct({
	approval_id: UuidString,
	box_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	packages: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(500),
		Schema.isUnique(),
	),
	approved_by: Schema.String.check(Schema.isMinLength(1)),
	approved_at: DateTimeString,
	revocable: Schema.Boolean,
	observed_at: DateTimeString,
});

// --- executors / heartbeats / tasks --------------------------------------------------------------

const ExecutorKindSchema = Schema.Literals([
	"manager",
	"dispatcher",
	"control-plane",
	"tracker",
	"library",
	"box-agent",
	"edge",
	"probe-runner",
	"pty",
	"console-api",
]);

export const ExecutorItemSchema = openStruct({
	kind: ExecutorKindSchema,
	ref: Schema.optional(NullableString),
	liveness: Schema.Literals(["alive", "suspect", "down", "unknown"]),
	last_seen_epoch: Schema.optional(NullableInt),
	detail: Schema.optional(NullableString),
});

export const HeartbeatItemSchema = openStruct({
	schema_version: Schema.Literal(2),
	version: Schema.String,
	handle: Schema.optional(Schema.NullOr(Handle)),
	pid: PositiveInt,
	state: Schema.Literals(["starting", "running", "rate_limited", "waiting", "crashed", "stopped"]),
	session_id: Schema.String,
	tmux_session: Schema.optional(NullableString),
	pane_id: Schema.optional(NullableString),
	io_ok: Schema.Boolean,
	crash_count: NonNegativeInt,
	started_at_epoch: NonNegativeInt,
	last_sync_ok_epoch: NonNegativeInt,
	updated_at_epoch: NonNegativeInt,
	channel_lock: Schema.optional(
		Schema.NullOr(
			openStruct({
				state: Schema.Literals(["held", "released", "lockout"]),
				owner: Schema.optional(NullableString),
				acquired_at_epoch: Schema.optional(Schema.NullOr(NonNegativeInt)),
				contender: Schema.optional(NullableString),
			}),
		),
	),
	host: Schema.String,
	observed_at: DateTimeString,
	rate_limit_reset_epoch: Schema.optional(NullableInt),
});

const taskFields = {
	id: PositiveInt,
	kind: Schema.String,
	title: Schema.String,
	body: Schema.optional(Schema.String),
	status: TaskStatusSchema,
	priority: Schema.Literals([0, 1, 2, 3]),
	project_id: Schema.optional(NullableInt),
	parent_id: Schema.optional(NullableInt),
	assignee: Schema.optional(Schema.String),
	claimed_by: Schema.optional(Schema.String),
	lease_expires_at: Schema.optional(NullableDateTime),
	blocked_on: Schema.optional(Schema.String),
	verification_status: Schema.optional(Schema.Literals(["unverified", "verified", "rejected"])),
	suggested_agent: Schema.optional(Schema.String),
	effort: Schema.optional(Schema.String),
	parallel_group: Schema.optional(Schema.String),
	rank: Schema.optional(Schema.Number),
	up_next: Schema.optional(Schema.Boolean),
	owner: Schema.optional(Schema.String),
	visibility: Schema.optional(Schema.Literals(["shared", "private"])),
	handoff_context: Schema.optional(Schema.String),
	acceptance_criteria: Schema.optional(Schema.String),
	result_summary: Schema.optional(Schema.String),
	close_reason: Schema.optional(Schema.String),
	created_by: Schema.optional(Schema.String),
	created_at: DateTimeString,
	updated_at: DateTimeString,
	capability: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
	owner_machine: Schema.optional(Schema.String),
	responsible: Schema.optional(Schema.String),
	body_alt: Schema.optional(Schema.String),
	max_children: Schema.optional(NullableInt),
	budget: Schema.optional(Schema.String),
	options: Schema.optional(Schema.String),
	answer: Schema.optional(Schema.String),
	source: Schema.optional(Schema.String),
	project_title: Schema.optional(NullableString),
} as const;

export const TaskItemSchema = openStruct(taskFields);

const SettlingTaskSchema = openStruct({ ...taskFields, settles_at: DateTimeString });

export const WorkSettlementSnapshotSchema = strictStruct({
	schema_version: Schema.Literal(1),
	observed_at: DateTimeString,
	settle_window_s: Schema.Literal(86_400),
	settled_this_week: NonNegativeInt,
	invalid_timestamp_count: NonNegativeInt,
	settling: Schema.Array(SettlingTaskSchema),
	history: Schema.Array(SettlingTaskSchema),
});

export const LeaseItemSchema = openStruct({
	schema_version: Schema.Literal(1),
	task_id: PositiveInt,
	worker: Handle,
	fence: Schema.optional(NonNegativeInt),
	granted_at: Schema.optional(DateTimeString),
	lease_expires_at: DateTimeString,
	lease_seconds: Schema.optional(PositiveInt),
});

// --- query plane ---------------------------------------------------------------------------------

export const QueryResultSchema = openStruct({
	schema_version: Schema.Literal(1),
	columns: Schema.Array(
		strictStruct({
			name: Schema.String,
			type: Schema.Literals(["string", "number", "boolean", "timestamp", "json"]),
		}),
	),
	rows: Schema.Array(Schema.Array(Schema.Unknown)),
	row_count: Int,
	execution_ms: Schema.optional(NullableNumber),
	freshness: strictStruct({
		source: Schema.String,
		observed_at: DateTimeString,
		window_s: Schema.optional(NullableNumber),
	}),
	query_ref: Schema.String,
	truncated: Schema.optional(Schema.Boolean),
});

export const CatalogEntrySchema = openStruct({
	type: Schema.String,
	first_seen: DateTimeString,
	last_emit: Schema.optional(NullableDateTime),
	scopes: Schema.Array(Schema.String),
	dimensions: Schema.Record(
		Schema.String,
		openStruct({
			type: Schema.Literals(["string", "boolean"]),
			cardinality: Schema.optional(Schema.NullOr(Schema.Literals(["low", "medium", "high"]))),
		}),
	),
	measures: Schema.Record(
		Schema.String,
		openStruct({
			kind: Schema.optional(
				Schema.NullOr(Schema.Literals(["gauge", "counter", "delta", "timestamp"])),
			),
			unit: Schema.optional(NullableString),
		}),
	),
	emit_rate_per_min: Schema.optional(Schema.NullOr(NonNegativeNumber)),
	joins: Schema.optional(
		Schema.Array(strictStruct({ rel: Schema.String, to_kind: Schema.String })),
	),
});

// --- dashboards ----------------------------------------------------------------------------------

export const DashboardItemSchema = openStruct({
	id: Schema.String,
	title: Schema.String,
	is_home: Schema.Boolean,
	kind: Schema.Literal("artifact"),
	created_by: Schema.String,
	responsible_human: Schema.optional(NullableString),
	updated_at: DateTimeString,
	panel_count: NonNegativeInt,
	scope: Schema.String,
	is_investigation: Schema.Boolean,
	parent_id: NullableString,
	parent_question: NullableString,
});

// --- edge ----------------------------------------------------------------------------------------

export const EdgeRegistryItemSchema = openStruct({
	pubkey_fp: Schema.String,
	handle: Schema.optional(Schema.NullOr(Handle)),
	host: Schema.optional(NullableString),
	state: Schema.Literals(["pending", "enrolled", "revoked"]),
	requested_handle: Schema.optional(NullableString),
	source_ip: Schema.optional(NullableString),
	first_seen_at: Schema.optional(NullableDateTime),
	enrolled_at: Schema.optional(NullableDateTime),
	enrolled_by: Schema.optional(NullableString),
	last_seen_at: Schema.optional(NullableDateTime),
});

export const EdgeSessionItemSchema = openStruct({
	session_id: Schema.String,
	handle: Handle,
	host: Schema.String,
	state: Schema.Literals(["open", "resuming", "floor", "closed"]),
	established_at: DateTimeString,
	resumes_count: NonNegativeInt,
	last_seen_at: DateTimeString,
	handshakes_clean_count: Schema.optional(Schema.NullOr(NonNegativeInt)),
	links: Schema.Array(
		openStruct({
			link_id: Schema.String,
			role: Schema.Literals(["primary", "standby"]),
			state: Schema.Literals(["active", "warm", "down"]),
			rtt_ms: Schema.optional(Schema.NullOr(NonNegativeNumber)),
			established_at: DateTimeString,
			last_flap_at: Schema.optional(NullableDateTime),
			flap_count_24h: NonNegativeInt,
		}),
	),
});

// --- signals -------------------------------------------------------------------------------------

export const SignalEmissionSchema = openStruct({
	schema_version: Schema.Literal(1),
	id: UuidString,
	type: Schema.String.check(
		Schema.isPattern(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/),
		Schema.isMaxLength(128),
	),
	ts: DateTimeString,
	source: openStruct({
		service: Schema.String.check(Schema.isMaxLength(64)),
		host: Schema.optional(NullableString),
		agent: Schema.optional(Schema.NullOr(Handle)),
	}),
	subject: Schema.String.check(Schema.isMaxLength(256)),
	subject_kind: Schema.optional(Schema.NullOr(SubjectKindSchema)),
	severity: SignalSeveritySchema,
	action: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(512)))),
	task_id: Schema.optional(NullableInt),
	scope: Schema.String.check(Schema.isPattern(EMISSION_SCOPE_RE)),
	dimensions: Schema.optional(
		Schema.Record(
			Schema.String,
			Schema.Union([Schema.String.check(Schema.isMaxLength(512)), Schema.Boolean]),
		).check(Schema.isMaxProperties(24)),
	),
	measures: Schema.optional(
		Schema.Record(Schema.String, Schema.Number).check(Schema.isMaxProperties(24)),
	),
	links: Schema.optional(
		Schema.Array(
			strictStruct({
				rel: Schema.String.check(Schema.isMaxLength(64)),
				to: strictStruct({
					kind: SubjectKindSchema,
					id: Schema.String.check(Schema.isMaxLength(256)),
				}),
			}),
		).check(Schema.isMaxLength(16)),
	),
	body_ref: Schema.optional(NullableString),
	meta: Schema.optional(
		openStruct({
			unit: Schema.optional(Schema.String),
			cardinality_hint: Schema.optional(Schema.Literals(["low", "medium", "high"])),
			fields: Schema.optional(
				Schema.Record(
					Schema.String,
					strictStruct({
						unit: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
						kind: Schema.optional(Schema.Literals(["gauge", "counter", "delta", "timestamp"])),
						cardinality: Schema.optional(Schema.Literals(["low", "medium", "high"])),
					}),
				),
			),
		}),
	),
});

export const SubscriptionItemSchema = openStruct({
	schema_version: Schema.Literal(1),
	pattern: Schema.String,
	filter: Schema.optional(
		Schema.NullOr(
			strictStruct({
				severity_gte: Schema.optional(SignalSeveritySchema),
				source_service: Schema.optional(Schema.String),
				subject: Schema.optional(Schema.String),
			}),
		),
	),
	tier: Schema.Literals(["feed", "digest", "interrupt"]),
	window: Schema.optional(
		Schema.NullOr(Schema.String.check(Schema.isPattern(/^([0-9]{2}:[0-9]{2}|[0-9]+[mh])$/))),
	),
	loud: Schema.optional(Schema.Boolean),
	note: Schema.optional(NullableString),
	owner: Schema.String,
	updated_by: Schema.optional(NullableString),
	updated_at: Schema.optional(NullableDateTime),
	storm: Schema.optional(
		Schema.NullOr(
			strictStruct({
				active: Schema.Boolean,
				event_count: NonNegativeInt,
				threshold: PositiveInt,
				window_started_at: DateTimeString,
				muted_at: DateTimeString,
				expires_at: DateTimeString,
				previous_tier: Schema.Literal("feed"),
				muted_by: Schema.Literal("system:bus"),
				undone_at: Schema.optional(DateTimeString),
				undone_by: Schema.optional(Schema.String),
			}),
		),
	),
});

export const DeliveryItemSchema = openStruct({
	owner: Schema.String,
	channel: Schema.Literal("matrix"),
	target: Schema.String,
	verified: Schema.Boolean,
	cocoon_until: Schema.optional(NullableDateTime),
	next_digest_at: Schema.optional(NullableDateTime),
	updated_at: DateTimeString,
	updated_by: Schema.String,
});

export const SignalSourceModeItemSchema = openStruct({
	source_service: Schema.String.check(Schema.isMaxLength(64)),
	mode: Schema.Literals(["normal", "development"]),
	note: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(240)))),
	updated_at: DateTimeString,
	updated_by: Schema.String,
});

// --- health --------------------------------------------------------------------------------------

// `bridges` items stay `unknown` on purpose: the served bridge rows have a source-specific shape
// (`observed_at`, per-source lag fields) that the retired JSON file never matched, and the
// generated public type already pinned `Array<unknown>`.
export const ConsoleHealthSchema = openStruct({
	lake: Schema.Literals(["ok", "degraded", "down"]),
	seq_head: Int,
	bridges: Schema.Array(Schema.Unknown),
	ws_clients: Schema.optional(Int),
	matrix_sync_ok_epoch: Schema.optional(NullableInt),
});

// --- comms ---------------------------------------------------------------------------------------

export const CardItemSchema = openStruct({
	card_id: Schema.String,
	task_id: PositiveInt,
	sender: Schema.String,
	sender_class: Schema.Literals(["principal", "agent", "system"]),
	recipient: Schema.optional(NullableString),
	priority: Schema.Literals([0, 1, 2, 3]),
	thread: Schema.optional(NullableString),
	requires_reply: Schema.optional(Schema.Boolean),
	interrupt_policy: Schema.Literals(["defer", "principal_command", "safety", "task_clarification"]),
	body: Schema.String,
	needs: Schema.Array(Schema.String),
	state: Schema.Literals(["posted", "parked", "claimed", "done", "dead"]),
	claimed_by: Schema.optional(NullableString),
	lease_expires_at_ms: Schema.optional(NullableInt),
	fence: NonNegativeInt,
	reaps: NonNegativeInt,
	reply_to: Schema.optional(NullableString),
	parent_id: Schema.optional(NullableString),
	result: Schema.optional(NullableString),
	delivered: Schema.optional(Schema.Boolean),
	addressed: Schema.optional(Schema.Boolean),
	created_at_ms: Int,
	updated_at_ms: Int,
});

export const CommsEventSchema = openStruct({
	id: UuidString,
	method: Schema.Literals(["comms.card", "comms.rpc", "comms.mail"]),
	sender: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	recipient: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	task_id: Schema.optional(Schema.NullOr(PositiveInt)),
	in_reply_to: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
	ts: DateTimeString,
	card_id: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
	about: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
	body_preview: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(240)))),
});

// --- attention -----------------------------------------------------------------------------------

export const AttentionItemSchema = openStruct({
	schema_version: Schema.Literal(1),
	id: Schema.String,
	grade: AttentionGradeSchema,
	source: Schema.String,
	subject: Schema.String,
	summary: Schema.String,
	ts: DateTimeString,
	scope: Schema.String,
	task_id: Schema.optional(NullableInt),
	incident_key: Schema.optional(NullableString),
	fix_ops: Schema.optional(Schema.Array(strictStruct({ op: Schema.String, args: JsonRest }))),
	acked_by: Schema.optional(NullableString),
	snoozed_until: Schema.optional(NullableDateTime),
	resolved_by: Schema.optional(NullableString),
	resolved_via: Schema.optional(Schema.NullOr(Schema.Literals(["ui", "agent", "auto"]))),
	resolved_at: Schema.optional(NullableDateTime),
	blast_radius: Schema.optional(
		Schema.NullOr(
			openStruct({
				hosts: Schema.optional(Int),
				residents: Schema.optional(Int),
				leases_expiring_30m: Schema.optional(Int),
				detail: Schema.optional(NullableString),
				host: Schema.optional(NullableString),
			}),
		),
	),
});

// --- op plane ------------------------------------------------------------------------------------

const opResultCommonFields = {
	schema_version: Schema.Literal(1),
	in_reply_to: UuidString,
	audit_seq: Schema.optional(NullableInt),
	executor: Schema.optional(
		Schema.NullOr(
			openStruct({
				kind: ExecutorKindSchema,
				ref: Schema.optional(NullableString),
				liveness: Schema.Literals(["alive", "suspect", "down", "unknown"]),
			}),
		),
	),
	undo: Schema.optional(Schema.NullOr(strictStruct({ op: Schema.String, args: JsonRest }))),
} as const;

const OpResultSuccessSchema = openStruct({
	...opResultCommonFields,
	ok: Schema.Literal(true),
	status: Schema.Literals(["applied", "accepted"]),
	result: Schema.optional(Schema.NullOr(JsonRest)),
	error: Schema.optional(Schema.Null),
});

const OpResultFailureSchema = openStruct({
	...opResultCommonFields,
	ok: Schema.Literal(false),
	status: Schema.optional(Schema.NullOr(Schema.Literals(["applied", "accepted"]))),
	result: Schema.optional(Schema.Null),
	error: openStruct({
		code: Schema.String.check(Schema.isPattern(/^[a-z0-9_]+$/)),
		message: Schema.String,
		retryable: Schema.Boolean,
	}),
});

/** `ok` discriminates the success/failure arms exactly as the retired oneOf did. */
export const OpResultSchema = Schema.Union([OpResultSuccessSchema, OpResultFailureSchema]);

// --- governance / roster -------------------------------------------------------------------------

export const GovernanceItemSchema = openStruct({
	agent: Handle,
	light: BudgetLightColorSchema,
	tokens_spent: NonNegativeNumber,
	granted_tokens: Schema.optional(Schema.NullOr(NonNegativeNumber)),
	grant_expires_epoch: Schema.optional(NullableInt),
	tier: Schema.optional(Schema.NullOr(Schema.Literals(["haiku", "sonnet", "opus"]))),
	rate_limit_hits: NonNegativeInt,
	last_rate_limited_epoch: Schema.optional(NullableInt),
	rate_limit_reset_epoch: Schema.optional(NullableInt),
});

export const RosterItemSchema = openStruct({
	handle: Handle,
	host: Schema.optional(NullableString),
	status: Schema.optional(Schema.NullOr(Schema.Literals(["alive", "working", "idle"]))),
	current_tool: Schema.optional(NullableString),
	task_id: Schema.optional(NullableInt),
	task_title: Schema.optional(NullableString),
	heartbeat_state: Schema.optional(
		Schema.NullOr(
			Schema.Literals(["starting", "running", "rate_limited", "waiting", "crashed", "stopped"]),
		),
	),
	crash_count: Schema.optional(Schema.NullOr(NonNegativeInt)),
	channel_lock_state: Schema.optional(
		Schema.NullOr(Schema.Literals(["held", "released", "lockout"])),
	),
	autonomy: Schema.optional(Schema.NullOr(Schema.Literals(["auto", "ask", "readonly", "paused"]))),
	lane: Schema.optional(NullableString),
	light: Schema.optional(Schema.NullOr(BudgetLightColorSchema)),
	tokens_spent: Schema.optional(NullableNumber),
	tier: Schema.optional(NullableString),
	lease_expires_at: Schema.optional(NullableDateTime),
	fence: Schema.optional(Schema.NullOr(NonNegativeInt)),
	workers_active: NonNegativeInt,
	updated_at: DateTimeString,
	observed_at: DateTimeString,
	fleet_updated_at: Schema.optional(NullableDateTime),
	started_at: Schema.optional(NullableDateTime),
	registry_last_seen_epoch: Schema.optional(NullableInt),
});

// --- the contract map ----------------------------------------------------------------------------

/** Every named server->client contract shape, keyed by its public contract-type name. */
export const CONTRACT_SCHEMAS = {
	Principal: PrincipalSchema,
	Me: MeSchema,
	ReadEnvelope: ReadEnvelopeSchema,
	AvailabilitySnapshot: AvailabilitySnapshotSchema,
	FleetItem: FleetItemSchema,
	RegistryItem: RegistryItemSchema,
	WorkerItem: WorkerItemSchema,
	BoxUpdateItem: BoxUpdateItemSchema,
	BoxUpdateRaw: BoxUpdateRawSchema,
	UpdateApproval: UpdateApprovalSchema,
	ExecutorItem: ExecutorItemSchema,
	HeartbeatItem: HeartbeatItemSchema,
	TaskItem: TaskItemSchema,
	WorkSettlementSnapshot: WorkSettlementSnapshotSchema,
	LeaseItem: LeaseItemSchema,
	QueryResult: QueryResultSchema,
	CatalogEntry: CatalogEntrySchema,
	DashboardItem: DashboardItemSchema,
	EdgeRegistryItem: EdgeRegistryItemSchema,
	EdgeSessionItem: EdgeSessionItemSchema,
	SignalEmission: SignalEmissionSchema,
	SubscriptionItem: SubscriptionItemSchema,
	DeliveryItem: DeliveryItemSchema,
	SignalSourceModeItem: SignalSourceModeItemSchema,
	ConsoleHealth: ConsoleHealthSchema,
	CardItem: CardItemSchema,
	AttentionItem: AttentionItemSchema,
	OpResult: OpResultSchema,
	GovernanceItem: GovernanceItemSchema,
	RosterItem: RosterItemSchema,
	CommsEvent: CommsEventSchema,
} as const;

export type ContractType = keyof typeof CONTRACT_SCHEMAS;
