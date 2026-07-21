/**
 * Public console contract types, derived from the Effect Schema single source of truth in
 * `src/lib/contracts/entities.ts` (rewrite Phase 4 — no parallel JSON-Schema, no codegen). Every
 * exported name matches the retired generated module; the structural shapes come from
 * `typeof XSchema.Type` with readonly modifiers stripped, so consumers keep plain mutable data.
 */
import { Cause, Exit, Schema } from "effect";

import {
	AttentionGradeSchema,
	AvailabilitySnapshotSchema,
	AttentionItemSchema,
	BoxUpdateItemSchema,
	BoxUpdateRawSchema,
	BudgetLightColorSchema,
	CardItemSchema,
	CatalogEntrySchema,
	CommsEventSchema,
	CONTRACT_SCHEMAS,
	ConsoleHealthSchema,
	DashboardItemSchema,
	DeliveryItemSchema,
	EdgeRegistryItemSchema,
	EdgeSessionItemSchema,
	ExecutorItemSchema,
	FleetItemSchema,
	GovernanceItemSchema,
	HeartbeatItemSchema,
	LaneSchema,
	LeaseItemSchema,
	MeSchema,
	OpResultSchema,
	QueryResultSchema,
	RegistryItemSchema,
	RosterItemSchema,
	SignalEmissionSchema,
	SignalSeveritySchema,
	SignalSourceModeItemSchema,
	StructuredQuerySchema,
	SubscriptionItemSchema,
	TaskItemSchema,
	TaskStatusSchema,
	UpdateApprovalSchema,
	WorkSettlementSnapshotSchema,
	WorkerItemSchema,
	type ContractType,
} from "../contracts/entities.ts";

export type { ContractType };

/** Deeply strips `readonly` from a schema-derived type; the wire data is plain mutable JSON. */
type Mutable<T> = T extends readonly (infer U)[]
	? Mutable<U>[]
	: T extends object
		? { -readonly [K in keyof T]: Mutable<T[K]> }
		: T;

export type Lane = typeof LaneSchema.Type;
export type SignalSeverity = typeof SignalSeveritySchema.Type;
export type AttentionGrade = typeof AttentionGradeSchema.Type;
export type BudgetLightColor = typeof BudgetLightColorSchema.Type;
export type TaskStatus = typeof TaskStatusSchema.Type;

export interface ReadEnvelope<T extends Record<string, unknown>> extends Record<string, unknown> {
	schema_version: 1;
	freshness: { source: string; observed_at: string; window_s?: number | null; [key: string]: unknown };
	items: T[];
	next_cursor: string | null;
	total?: number | null;
	truncated?: boolean;
}
export type StructuredQuery = Mutable<typeof StructuredQuerySchema.Type>;

export type Me = Mutable<typeof MeSchema.Type>;
export type AvailabilitySnapshot = Mutable<typeof AvailabilitySnapshotSchema.Type>;
export type FleetItem = Mutable<typeof FleetItemSchema.Type>;
export type RegistryItem = Mutable<typeof RegistryItemSchema.Type>;
export type WorkerItem = Mutable<typeof WorkerItemSchema.Type>;
export type BoxUpdateItem = Mutable<typeof BoxUpdateItemSchema.Type>;
export type BoxUpdateRaw = Mutable<typeof BoxUpdateRawSchema.Type>;
export type UpdateApproval = Mutable<typeof UpdateApprovalSchema.Type>;
export type ExecutorItem = Mutable<typeof ExecutorItemSchema.Type>;
export type HeartbeatItem = Mutable<typeof HeartbeatItemSchema.Type>;
export type TaskItem = Mutable<typeof TaskItemSchema.Type>;
export type WorkSettlementSnapshot = Mutable<typeof WorkSettlementSnapshotSchema.Type>;
export type LeaseItem = Mutable<typeof LeaseItemSchema.Type>;
export type QueryResult = Mutable<typeof QueryResultSchema.Type>;
export type CatalogEntry = Mutable<typeof CatalogEntrySchema.Type>;
export type DashboardItem = Mutable<typeof DashboardItemSchema.Type>;
export type EdgeRegistryItem = Mutable<typeof EdgeRegistryItemSchema.Type>;
export type EdgeSessionItem = Mutable<typeof EdgeSessionItemSchema.Type>;
export type SignalEmission = Mutable<typeof SignalEmissionSchema.Type>;
export type SubscriptionItem = Mutable<typeof SubscriptionItemSchema.Type>;
export type DeliveryItem = Mutable<typeof DeliveryItemSchema.Type>;
export type SignalSourceModeItem = Mutable<typeof SignalSourceModeItemSchema.Type>;
export type ConsoleHealth = Mutable<typeof ConsoleHealthSchema.Type>;
export type CardItem = Mutable<typeof CardItemSchema.Type>;
export type AttentionItem = Mutable<typeof AttentionItemSchema.Type>;
export type OpResult = Mutable<typeof OpResultSchema.Type>;
export type GovernanceItem = Mutable<typeof GovernanceItemSchema.Type>;
export type RosterItem = Mutable<typeof RosterItemSchema.Type> & {
	sources?: Record<
		"fleet" | "heartbeat" | "registry" | "governance" | "identity" | "lease",
		{ visibility: "visible" | "absent" | "unavailable"; observed_at: string | null }
	>;
};
export type CommsEvent = Mutable<typeof CommsEventSchema.Type>;

export type GovernancePool = {
	pool_tokens: number; pool_spent: number; fleet_mode: "parallel" | "sequential"; cascade_active: boolean; [key: string]: unknown;
};

/** @public Compatibility fixtures for contract consumers and tests. */
export const CONTRACT_FIXTURES = {
	"ReadEnvelope": {
		"schema_version": 1,
		"freshness": { "source": "lake", "observed_at": "2026-07-19T00:00:00Z", "window_s": null },
		"items": [],
		"next_cursor": null,
		"truncated": false,
	},
	"Principal": {
		"schema_version": 1,
		"kind": "human",
		"id": "fixture",
		"tiers": [],
		"lanes": [],
		"scopes": [],
		"zookie": "fixture"
	},
	"Me": {
		"schema_version": 1,
		"kind": "human",
		"id": "fixture",
		"tiers": [],
		"lanes": [],
		"scopes": [],
		"zookie": "fixture"
	},
	"AvailabilitySnapshot": {
		"schema_version": 1,
		"freshness": {
			"source": "lake",
			"observed_at": "2026-01-01T00:00:00Z",
			"window_s": 1
		},
		"probe_runner": "fixture",
		"items": []
	},
	"FleetItem": {
		"handle": "fixture",
		"status": "alive",
		"updated_at": "2026-01-01T00:00:00Z",
		"observed_at": "2026-01-01T00:00:00Z"
	},
	"RegistryItem": {
		"handle": "fixture",
		"provides": [],
		"free_slots": 0,
		"last_seen_epoch": 0
	},
	"WorkerItem": {
		"handle": "fixture",
		"host": "fixture",
		"label": "fixture",
		"started_at": "2026-01-01T00:00:00Z",
		"updated_at": "2026-01-01T00:00:00Z"
	},
	"BoxUpdateItem": {
		"box_id": "fixture",
		"hostname": "fixture",
		"source_tool": "fixture",
		"agent_vs_agentless": "agent",
		"status": "up_to_date",
		"updated_at": "2026-01-01T00:00:00Z"
	},
	"BoxUpdateRaw": {
		"box_id": "fixture",
		"packages": [],
		"vulns": [],
		"collected_at": "2026-01-01T00:00:00Z"
	},
	"UpdateApproval": {
		"approval_id": "00000000-0000-4000-8000-000000000000",
		"box_id": "fixture",
		"packages": [
			"fixture"
		],
		"approved_by": "fixture",
		"approved_at": "2026-01-01T00:00:00Z",
		"revocable": false,
		"observed_at": "2026-01-01T00:00:00Z"
	},
	"ExecutorItem": {
		"kind": "manager",
		"liveness": "alive"
	},
	"HeartbeatItem": {
		"schema_version": 2,
		"version": "fixture",
		"pid": 1,
		"state": "starting",
		"session_id": "fixture",
		"io_ok": false,
		"crash_count": 0,
		"started_at_epoch": 0,
		"last_sync_ok_epoch": 0,
		"updated_at_epoch": 0,
		"host": "fixture",
		"observed_at": "2026-01-01T00:00:00Z"
	},
	"TaskItem": {
		"id": 1,
		"kind": "fixture",
		"title": "fixture",
		"status": "inbox",
		"priority": 0,
		"created_at": "2026-01-01T00:00:00Z",
		"updated_at": "2026-01-01T00:00:00Z"
	},
	"WorkSettlementSnapshot": {
		"schema_version": 1,
		"observed_at": "2026-01-01T00:00:00Z",
		"settle_window_s": 86400,
		"settled_this_week": 0,
		"invalid_timestamp_count": 0,
		"settling": [],
		"history": []
	},
	"LeaseItem": {
		"schema_version": 1,
		"task_id": 1,
		"worker": "fixture",
		"lease_expires_at": "2026-01-01T00:00:00Z"
	},
	"QueryResult": {
		"schema_version": 1,
		"columns": [],
		"rows": [],
		"row_count": 0,
		"freshness": {
			"source": "fixture",
			"observed_at": "2026-01-01T00:00:00Z"
		},
		"query_ref": "fixture"
	},
	"CatalogEntry": {
		"type": "fixture",
		"first_seen": "2026-01-01T00:00:00Z",
		"scopes": [],
		"dimensions": {},
		"measures": {}
	},
	"DashboardItem": {
		"id": "fixture",
		"title": "fixture",
		"is_home": false,
		"kind": "artifact",
		"created_by": "fixture",
		"updated_at": "2026-01-01T00:00:00Z",
		"panel_count": 0,
		"scope": "fixture",
		"is_investigation": false,
		"parent_id": "fixture",
		"parent_question": "fixture"
	},
	"EdgeRegistryItem": {
		"pubkey_fp": "fixture",
		"state": "pending"
	},
	"EdgeSessionItem": {
		"session_id": "fixture",
		"handle": "fixture",
		"host": "fixture",
		"state": "open",
		"established_at": "2026-01-01T00:00:00Z",
		"resumes_count": 0,
		"last_seen_at": "2026-01-01T00:00:00Z",
		"links": []
	},
	"SignalEmission": {
		"schema_version": 1,
		"id": "00000000-0000-4000-8000-000000000000",
		"type": "fixture.value",
		"ts": "2026-01-01T00:00:00Z",
		"source": {
			"service": "fixture"
		},
		"subject": "fixture",
		"severity": "debug",
		"scope": "fleet"
	},
	"SubscriptionItem": {
		"schema_version": 1,
		"pattern": "fixture",
		"tier": "feed",
		"owner": "fixture"
	},
	"DeliveryItem": {
		"owner": "fixture",
		"channel": "matrix",
		"target": "fixture",
		"verified": false,
		"updated_at": "2026-01-01T00:00:00Z",
		"updated_by": "fixture"
	},
	"SignalSourceModeItem": {
		"source_service": "fixture",
		"mode": "normal",
		"updated_at": "2026-01-01T00:00:00Z",
		"updated_by": "fixture"
	},
	"ConsoleHealth": {
		"lake": "ok",
		"seq_head": 0,
		"bridges": []
	},
	"CardItem": {
		"card_id": "fixture",
		"task_id": 1,
		"sender": "fixture",
		"sender_class": "principal",
		"priority": 0,
		"interrupt_policy": "defer",
		"body": "fixture",
		"needs": [],
		"state": "posted",
		"fence": 0,
		"reaps": 0,
		"delivered": false,
		"addressed": false,
		"created_at_ms": 0,
		"updated_at_ms": 0
	},
	"AttentionItem": {
		"schema_version": 1,
		"id": "fixture",
		"grade": "p0",
		"source": "fixture",
		"subject": "fixture",
		"summary": "fixture",
		"ts": "2026-01-01T00:00:00Z",
		"scope": "fixture"
	},
	"OpResult": {
		"schema_version": 1,
		"in_reply_to": "00000000-0000-4000-8000-000000000000",
		"ok": true,
		"status": "applied"
	},
	"GovernanceItem": {
		"agent": "fixture",
		"light": "green",
		"tokens_spent": 0,
		"rate_limit_hits": 0
	},
	"RosterItem": {
		"handle": "fixture",
		"workers_active": 0,
		"updated_at": "2026-01-01T00:00:00Z",
		"observed_at": "2026-01-01T00:00:00Z"
	},
	"CommsEvent": {
		"id": "00000000-0000-4000-8000-000000000000",
		"method": "comms.card",
		"sender": "fixture",
		"recipient": "fixture",
		"ts": "2026-01-01T00:00:00Z"
	}
} as const satisfies Record<ContractType, unknown>;

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/** @public Validate an API value against its canonical Effect Schema. */
export function validateContract(type: ContractType, value: unknown): ValidationResult {
	const exit = Schema.decodeUnknownExit(CONTRACT_SCHEMAS[type])(value, { errors: "all" });
	if (Exit.isSuccess(exit)) return { valid: true, errors: [] };
	return { valid: false, errors: [Cause.pretty(exit.cause)] };
}
