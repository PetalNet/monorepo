/**
 * TypeScript mirrors of the console-api contract shapes
 * (apps/console-api/docs/contracts/schemas/**). Hand-written — no codegen exists yet. Field names +
 * enums are EXACT to the schemas; where this drifts from a schema, the schema wins and this file
 * has a bug. Server->client shapes are additionalProperties:true, so every interface carries an
 * index signature and consumers ignore unknown fields (Rule 1). This is the shell's subset; each
 * surface adds the entity shapes it reads (heartbeat, card, roster, ...).
 */

type Extra = Record<string, unknown>;

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

// ---- attention (GET /attention, section 5.3) ----
export type AttentionGrade = "p0" | "blocker" | "review" | "artifact";
export interface FixOp extends Extra {
	op: string;
	args: Record<string, unknown>;
}
export interface BlastRadius extends Extra {
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
