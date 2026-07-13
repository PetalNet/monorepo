/**
 * TypeScript mirrors of the console-api contract shapes
 * (apps/console-api/docs/contracts/schemas/**). Hand-written — no codegen exists yet. Field names +
 * enums are EXACT to the schemas; where this drifts from a schema, the schema wins and this file
 * has a bug. Server->client shapes are additionalProperties:true, so every interface carries an
 * index signature and consumers ignore unknown fields (Rule 1). This is the shell's subset; each
 * surface adds the entity shapes it reads (heartbeat, card, roster, ...).
 */

type Extra = Record<string, unknown>;

export interface ReadEnvelope<T extends Extra> extends Extra {
	schema_version: 1;
	freshness: {
		source: string;
		observed_at: string;
		window_s?: number | null;
		[key: string]: unknown;
	};
	items: T[];
	next_cursor: string | null;
	total?: number | null;
	truncated?: boolean;
}

// ---- principal / me (section 1.2) ----
export type PrincipalKind = "human" | "agent" | "system";
export type Lane = "viewer" | "editor" | "operator" | "admin" | "term_admin";

export interface Principal extends Extra {
	schema_version: 1;
	kind: PrincipalKind;
	id: string;
	tiers: string[];
	lanes: string[];
	scopes: string[];
	zookie: string;
}

export interface Me extends Principal {
	display_name?: string | null;
	grant_name?: string | null;
}

// ---- fleet (GET /fleet) ----
export type FleetStatus = "alive" | "working" | "idle";
export interface FleetItem extends Extra {
	handle: string;
	host?: string | null;
	event?: "session_start" | "pre_tool" | "post_tool" | "stop";
	status: FleetStatus;
	current_tool?: string | null;
	task_id?: number | null;
	session_id?: string | null;
	started_at?: string;
	updated_at: string;
	observed_at: string;
}

// ---- registry (GET /registry) ----
export interface RegistryItem extends Extra {
	handle: string;
	provides: string[];
	free_slots: number;
	host?: string | null;
	last_seen_epoch: number;
}

// ---- box updates (GET /box-updates) ----
export type BoxUpdateStatus =
	| "up_to_date"
	| "updates_pending"
	| "updates_overdue"
	| "error_collecting";
export interface BoxUpdateItem extends Extra {
	box_id: string;
	hostname: string;
	os_family?: string | null;
	os_version?: string | null;
	source_tool: string;
	agent_vs_agentless: "agent" | "agentless";
	pending_updates_count?: number | null;
	security_critical_count?: number | null;
	vuln_count?: number | null;
	reboot_required?: 0 | 1 | null;
	last_checked_at?: string | null;
	last_applied_at?: string | null;
	update_channel?: string | null;
	apply_mode?: "auto" | "staged-approval" | "manual-notify-only" | null;
	status: BoxUpdateStatus;
	raw_ref?: string | null;
	updated_at: string;
}

export interface BoxUpdatePackage extends Extra {
	name: string;
	from?: string;
	to?: string;
	security: boolean;
}
export interface BoxUpdateVulnerability extends Extra {
	cve_id: string;
	severity: "critical" | "high" | "moderate" | "low";
	package: string;
	fixed_in?: string | null;
}
export interface BoxUpdateRaw extends Extra {
	box_id: string;
	packages: BoxUpdatePackage[];
	vulns: BoxUpdateVulnerability[];
	collected_at: string;
}

export interface ExecutorItem extends Extra {
	kind:
		| "manager"
		| "dispatcher"
		| "control-plane"
		| "tracker"
		| "library"
		| "box-agent"
		| "edge"
		| "probe-runner"
		| "console-api";
	ref?: string | null;
	liveness: "alive" | "suspect" | "down" | "unknown";
	last_seen_epoch?: number | null;
	detail?: string | null;
}

// ---- accounting (POST /query, GET /catalog, GET /dashboards) ----
export type QueryColumnType = "string" | "number" | "boolean" | "timestamp" | "json";
export interface QueryColumn {
	name: string;
	type: QueryColumnType;
}
export interface StructuredQuery extends Extra {
	schema_version: 1;
	mode: "structured";
	from: string;
	select?: { field: string; agg?: string | null; as?: string }[];
	where?: Record<string, unknown>;
	group_by?: string[];
	time?: {
		from?: string;
		to?: string | null;
		bucket?: string | null;
		fill?: "none" | "null" | "zero" | "previous" | null;
		coverage?: boolean;
	} | null;
	order?: { field: string; dir: "asc" | "desc" }[] | null;
	limit?: number | null;
}
export interface QueryResult extends Extra {
	schema_version: 1;
	columns: QueryColumn[];
	rows: unknown[][];
	row_count: number;
	execution_ms?: number | null;
	freshness: { source: string; observed_at: string; window_s?: number | null };
	query_ref: string;
	truncated?: boolean;
}
export interface CatalogEntry extends Extra {
	type: string;
	first_seen: string;
	last_emit?: string | null;
	scopes: string[];
	dimensions: Record<string, { type: "string" | "boolean"; cardinality?: string | null }>;
	measures: Record<
		string,
		{ kind?: "gauge" | "counter" | "delta" | "timestamp" | null; unit?: string | null }
	>;
	emit_rate_per_min?: number | null;
}
export interface DashboardItem extends Extra {
	id: string;
	title: string;
	is_home: boolean;
	kind: "artifact";
	created_by: string;
	responsible_human?: string | null;
	updated_at: string;
	panel_count: number;
	scope: string;
}

export interface EdgeRegistryItem extends Extra {
	pubkey_fp: string;
	handle?: string | null;
	host?: string | null;
	state: "pending" | "enrolled" | "revoked";
	requested_handle?: string | null;
	source_ip?: string | null;
	first_seen_at?: string | null;
	enrolled_at?: string | null;
	enrolled_by?: string | null;
	last_seen_at?: string | null;
}
export interface EdgeLink extends Extra {
	link_id: string;
	role: "primary" | "standby";
	state: "active" | "warm" | "down";
	rtt_ms?: number | null;
	established_at: string;
	last_flap_at?: string | null;
	flap_count_24h: number;
}
export interface EdgeSessionItem extends Extra {
	session_id: string;
	handle: string;
	host: string;
	state: "open" | "resuming" | "floor" | "closed";
	established_at: string;
	resumes_count: number;
	last_seen_at: string;
	handshakes_clean_count?: number | null;
	links: EdgeLink[];
}

export type SignalSeverity = "debug" | "info" | "warn" | "danger" | "p0";
export interface SignalEmission extends Extra {
	schema_version: 1;
	id: string;
	type: string;
	ts: string;
	source: { service: string; host?: string | null; agent?: string | null; [key: string]: unknown };
	subject: string;
	subject_kind?: string | null;
	severity: SignalSeverity;
	action?: string | null;
	task_id?: number | null;
	scope: string;
	dimensions?: Record<string, string | boolean>;
	measures?: Record<string, number>;
}
export interface SubscriptionItem extends Extra {
	schema_version: 1;
	pattern: string;
	filter?: { severity_gte?: SignalSeverity; source_service?: string; subject?: string } | null;
	tier: "feed" | "digest" | "interrupt";
	window?: string | null;
	loud?: boolean;
	note?: string | null;
	owner: string;
	updated_by?: string | null;
	updated_at?: string | null;
}
export interface DeliveryItem extends Extra {
	owner: string;
	channel: "matrix";
	target: string;
	verified: boolean;
	cocoon_until?: string | null;
	next_digest_at?: string | null;
	updated_at: string;
	updated_by: string;
}
export interface ConsoleHealth extends Extra {
	lake: "ok" | "down";
	seq_head: number;
	bridges: unknown[];
	ws_clients?: number;
	matrix_sync_ok_epoch?: number | null;
}
export interface CardItem extends Extra {
	card_id: string;
	task_id: number;
	sender: string;
	sender_class: "principal" | "agent" | "system";
	recipient?: string | null;
	priority: 0 | 1 | 2 | 3;
	interrupt_policy: "defer" | "principal_command" | "safety" | "task_clarification";
	body: string;
	needs: string[];
	state: "posted" | "parked" | "claimed" | "done" | "dead";
	claimed_by?: string | null;
	fence: number;
	reaps: number;
	created_at_ms: number;
	updated_at_ms: number;
}

// ---- attention (GET /attention, section 5.3) ----
export type AttentionGrade = "p0" | "blocker" | "review" | "artifact";
export interface FixOp extends Extra {
	op: string;
	args: Record<string, unknown>;
}
export interface BlastRadius extends Extra {
	/** The host the crash/incident lives on — the "open the house" target. */
	host?: string | null;
	hosts?: number;
	residents?: number;
	leases_expiring_30m?: number;
	detail?: string | null;
}
export interface AttentionItem extends Extra {
	schema_version: 1;
	id: string;
	grade: AttentionGrade;
	source: string;
	subject: string;
	summary: string;
	ts: string;
	scope: string;
	task_id?: number | null;
	incident_key?: string | null;
	fix_ops?: FixOp[];
	acked_by?: string | null;
	snoozed_until?: string | null;
	resolved_by?: string | null;
	resolved_via?: "ui" | "agent" | "auto" | null;
	resolved_at?: string | null;
	blast_radius?: BlastRadius | null;
}

// ---- command plane (section 5.1) ----
export type OpStatus = "applied" | "accepted";
export interface OpResult extends Extra {
	schema_version?: number;
	ok: boolean;
	status: OpStatus;
	result?: Record<string, unknown>;
	undo?: { op: string; args: Record<string, unknown> } | null;
	audit_seq?: number | null;
}
export interface ApiError {
	code: string; // snake_case
	message: string;
	retryable: boolean;
}

// ---- roster (GET /roster) — server-side join, one row per agent ----
export type HeartbeatState =
	| "starting"
	| "running"
	| "rate_limited"
	| "waiting"
	| "crashed"
	| "stopped";
export type Autonomy = "auto" | "ask" | "readonly" | "paused";
export type BudgetLightColor = "green" | "yellow" | "red";
export interface RosterItem extends Extra {
	handle: string;
	host?: string | null;
	status?: FleetStatus | null;
	current_tool?: string | null;
	task_id?: number | null;
	task_title?: string | null;
	heartbeat_state?: HeartbeatState | null;
	crash_count?: number | null;
	channel_lock_state?: "held" | "released" | "lockout" | null;
	autonomy?: Autonomy | null;
	lane?: string | null;
	light?: BudgetLightColor | null;
	tokens_spent?: number | null;
	tier?: string | null;
	lease_expires_at?: string | null;
	fence?: number | null;
	workers_active: number;
	updated_at: string;
	observed_at: string;
	fleet_updated_at?: string | null;
	started_at?: string | null;
	registry_last_seen_epoch?: number | null;
}

// ---- comms projection (derived view for the Envelope / mail rail) ----
export type CommsMethod = "comms.card" | "comms.rpc" | "comms.mail";
export interface CommsEvent extends Extra {
	id: string;
	method: CommsMethod;
	sender: string;
	recipient: string;
	task_id?: number | null;
	in_reply_to?: string | null;
	ts: string;
	card_id?: string | null;
}
