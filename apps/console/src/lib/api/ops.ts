/**
 * The console command surface, derived at module load from the canonical op catalog
 * (docs/contracts/ops.json) decoded through its Effect Schema — the module fails loudly on catalog
 * drift (rewrite Phase 4, no codegen). Wire metadata and argument schemas are canonical; only
 * button verbs are UI-owned.
 */
import { Cause, Exit, Schema } from "effect";

import opCatalogJson from "../../../docs/contracts/ops.json" with { type: "json" };
import { validateJsonSchema, type JsonSchema } from "../contracts/json-schema.ts";
import { OpCatalogSchema } from "../contracts/op-catalog.ts";
import type { Lane } from "./types.ts";

const catalogExit = Schema.decodeUnknownExit(OpCatalogSchema)(opCatalogJson, { errors: "all" });
if (Exit.isFailure(catalogExit))
	throw new Error(`ops.json does not match the op catalog contract:\n${Cause.pretty(catalogExit.cause)}`);
const catalog = catalogExit.value;

export type ConfirmKind = "none" | "soft" | "hard";

/** Every op the catalog ships; asserted against ops.json at module load and in the contract test. */
const OP_NAMES = [
	"attention.ack",
	"attention.snooze",
	"attention.resolve",
	"task.get_ready",
	"task.up_next",
	"task.claim",
	"task.update",
	"task.close",
	"task.dispatch",
	"agent.start",
	"agent.stop",
	"agent.restart",
	"agent.kill_session",
	"agent.autonomy",
	"governance.action",
	"governance.tier",
	"fleet.mode",
	"channel.reclaim",
	"signal.snooze",
	"signal.source_mode",
	"subscription.set",
	"subscription.remove",
	"card.repost",
	"card.park",
	"stats.query",
	"viz.render",
	"text.surface",
	"window.arrange",
	"dashboard.save",
	"dashboard.load",
	"dashboard.set_home",
	"dashboard.pin",
	"dashboard.delete",
	"dashboard.share",
	"context.receive",
	"kb.search",
	"kb.research",
	"library.item.create",
	"library.item.update",
	"library.capability.propose",
	"library.capability.review",
	"library.link.add",
	"library.hold",
	"curation.propose",
	"curation.approve",
	"curation.reject",
	"item.weed",
	"item.merge",
	"item.delete",
	"promotion.request",
	"promotion.approve",
	"service.restart",
	"service.stop",
	"service.logs",
	"host.probe",
	"host.reboot",
	"updates.check",
	"updates.approve",
	"updates.revoke",
	"updates.apply",
	"edge.enroll.approve",
	"edge.enroll.deny",
	"edge.key.revoke",
	"doorman.session.drop",
	"doorman.redial",
	"term.watch",
	"term.attach",
	"term.input",
	"term.resize",
	"term.scrollback",
	"term.detach",
	"delivery.test",
	"delivery.set_target",
	"delivery.resend",
	"delivery.cocoon",
] as const;
export type OpName = (typeof OP_NAMES)[number];

export interface OpDef {
	op: OpName; verb: string; lane: Lane; executor: string; confirm: ConfirmKind;
	undo: boolean; humanOnly: boolean; args: JsonSchema;
}

/** UI-owned button verbs; ops without an override get their last op segment title-cased. */
const VERBS: Partial<Record<OpName, string>> = {
	"stats.query": "Re-run",
	"viz.render": "Regenerate",
	"dashboard.save": "Save",
	"dashboard.load": "Load",
	"dashboard.delete": "Delete",
	"agent.restart": "Restart",
	"task.dispatch": "Dispatch",
	"task.claim": "Claim",
	"task.update": "Update",
	"task.close": "Close",
	"governance.action": "Pause",
	"governance.tier": "Tier",
	"signal.snooze": "Quiet 1h",
	"attention.ack": "Ack",
	"attention.snooze": "Snooze",
	"attention.resolve": "Done",
	"term.watch": "Watch session",
	"term.attach": "Attach",
	"term.detach": "Detach",
	"agent.stop": "Stop",
	"dashboard.set_home": "Set as home",
	"dashboard.pin": "Pin to home",
	"updates.check": "Check now",
	"updates.approve": "Approve",
	"updates.revoke": "Revoke approval",
	"updates.apply": "Apply now",
	"host.reboot": "Reboot",
	"edge.enroll.approve": "Approve enrollment",
	"edge.enroll.deny": "Deny",
	"doorman.session.drop": "Drop session",
	"doorman.redial": "Redial",
	"subscription.set": "Save",
	"subscription.remove": "Remove",
	"card.repost": "Re-post",
	"card.park": "Park",
	"delivery.test": "Send a test",
	"delivery.set_target": "Change target",
	"delivery.resend": "Resend",
	"delivery.cocoon": "Until 07:00",
};

function defaultVerb(op: string): string {
	const word = (op.split(".").at(-1) ?? op).replaceAll("_", " ");
	return word.slice(0, 1).toUpperCase() + word.slice(1);
}

const KNOWN_OPS: ReadonlySet<string> = new Set(OP_NAMES);
const OPS = Object.fromEntries(
	catalog.ops.map((entry) => {
		if (!KNOWN_OPS.has(entry.op))
			throw new Error(`ops.json declares an op unknown to the console UI: ${entry.op}`);
		const op = entry.op as OpName;
		return [
			op,
			{
				op,
				verb: VERBS[op] ?? defaultVerb(op),
				lane: entry.lane,
				executor: entry.executor,
				confirm: entry.confirm === "typed-name" ? "hard" : (entry.confirm ?? "none"),
				undo: entry.undo ?? false,
				humanOnly: entry.human_only ?? false,
				args: entry.args,
			} satisfies OpDef,
		];
	}),
) as Record<OpName, OpDef>;
if (Object.keys(OPS).length !== OP_NAMES.length)
	throw new Error("ops.json and the console op-name list have drifted");

/** @public Valid arguments for compatibility tests and downstream consumers. */
export const OP_TEST_FIXTURES = {
	"attention.ack": {
		"id": "fixture"
	},
	"attention.snooze": {
		"id": "fixture"
	},
	"attention.resolve": {
		"id": "fixture"
	},
	"task.get_ready": {},
	"task.up_next": {
		"id": 0
	},
	"task.claim": {},
	"task.update": {
		"id": 0,
		"patch": {}
	},
	"task.close": {
		"id": 0,
		"status": "done",
		"reason": "fixture"
	},
	"task.dispatch": {
		"body": "fixture"
	},
	"agent.start": {
		"handle": "fixture"
	},
	"agent.stop": {
		"handle": "fixture"
	},
	"agent.restart": {
		"handle": "fixture"
	},
	"agent.kill_session": {
		"handle": "fixture",
		"confirm_name": "fixture"
	},
	"agent.autonomy": {
		"handle": "fixture",
		"autonomy": "auto"
	},
	"governance.action": {
		"handle": "fixture",
		"action": "pause"
	},
	"governance.tier": {
		"handle": "fixture",
		"tier": "haiku"
	},
	"fleet.mode": {
		"mode": "parallel"
	},
	"channel.reclaim": {
		"handle": "fixture"
	},
	"signal.snooze": {
		"type_pattern": "fixture"
	},
	"signal.source_mode": {
		"source_service": "fixture",
		"mode": "normal"
	},
	"subscription.set": {
		"pattern": "fixture",
		"tier": "feed"
	},
	"subscription.remove": {
		"pattern": "fixture"
	},
	"card.repost": {
		"card_id": "fixture"
	},
	"card.park": {
		"card_id": "fixture"
	},
	"stats.query": {
		"schema_version": 1,
		"mode": "structured",
		"from": "fixture"
	},
	"viz.render": {
		"panel": {
			"schema_version": 2,
			"type": "text",
			"title": "fixture",
			"prose": "fixture"
		}
	},
	"text.surface": {
		"prose": "fixture"
	},
	"window.arrange": {
		"dashboard_id": "fixture",
		"ops": []
	},
	"dashboard.save": {
		"title": "fixture",
		"panels": []
	},
	"dashboard.load": {
		"id": "fixture"
	},
	"dashboard.set_home": {
		"id": "fixture"
	},
	"dashboard.pin": {
		"panel": {
			"schema_version": 2,
			"type": "text",
			"title": "fixture",
			"prose": "fixture"
		}
	},
	"dashboard.delete": {
		"id": "fixture"
	},
	"dashboard.share": {
		"id": "fixture",
		"subject": "fixture"
	},
	"context.receive": {
		"payload": {
			"element_kind": "fixture",
			"value": null
		}
	},
	"kb.search": {
		"q": "fixture"
	},
	"kb.research": {
		"query": "fixture"
	},
	"library.item.create": {
		"item": {
			"kind": "fixture",
			"title": "fixture",
			"scope": "fixture"
		}
	},
	"library.item.update": {
		"id": "fixture",
		"patch": {}
	},
	"library.capability.propose": {
		"capability": "fixture",
		"title": "fixture",
		"version": "fixture",
		"scope": "fixture",
		"artifact_base64": "fixture"
	},
	"library.capability.review": {
		"proposal_id": "fixture",
		"decision": "under-review"
	},
	"library.link.add": {
		"from_id": "fixture",
		"to_id": "fixture",
		"rel_type": "belongs-to"
	},
	"library.hold": {
		"item_id": "fixture",
		"for_user": "fixture"
	},
	"curation.propose": {
		"type": "weed",
		"item_id": "fixture",
		"reason": "fixture"
	},
	"curation.approve": {
		"proposal_id": "fixture"
	},
	"curation.reject": {
		"proposal_id": "fixture"
	},
	"item.weed": {
		"id": "fixture"
	},
	"item.merge": {
		"id": "fixture",
		"into_id": "fixture"
	},
	"item.delete": {
		"id": "fixture",
		"confirm_name": "fixture"
	},
	"promotion.request": {
		"id": "fixture"
	},
	"promotion.approve": {
		"request_id": "fixture"
	},
	"service.restart": {
		"host": "fixture",
		"service": "fixture"
	},
	"service.stop": {
		"host": "fixture",
		"service": "fixture",
		"confirm_name": "fixture"
	},
	"service.logs": {
		"host": "fixture",
		"service": "fixture"
	},
	"host.probe": {
		"target": "fixture"
	},
	"host.reboot": {
		"box_id": "fixture",
		"confirm_name": "fixture"
	},
	"updates.check": {
		"box_id": "fixture"
	},
	"updates.approve": {
		"box_id": "fixture",
		"packages": [
			"fixture"
		]
	},
	"updates.revoke": {
		"approval_id": "00000000-0000-4000-8000-000000000000"
	},
	"updates.apply": {
		"box_id": "fixture"
	},
	"edge.enroll.approve": {
		"pubkey_fp": "fixture",
		"handle": "fixture"
	},
	"edge.enroll.deny": {
		"pubkey_fp": "fixture"
	},
	"edge.key.revoke": {
		"pubkey_fp": "fixture",
		"confirm_name": "fixture"
	},
	"doorman.session.drop": {
		"session_id": "fixture"
	},
	"doorman.redial": {
		"handle": "fixture"
	},
	"term.watch": {
		"host": "fixture",
		"tmux_session": "fixture",
		"pane_id": "fixture"
	},
	"term.attach": {
		"stream_id": "fixture"
	},
	"term.input": {
		"stream_id": "fixture",
		"seq": 0,
		"data_b64": "fixture"
	},
	"term.resize": {
		"stream_id": "fixture",
		"cols": 0,
		"rows": 0
	},
	"term.scrollback": {
		"stream_id": "fixture",
		"lines": 0
	},
	"term.detach": {
		"stream_id": "fixture"
	},
	"delivery.test": {},
	"delivery.set_target": {
		"channel": "matrix",
		"target": "fixture"
	},
	"delivery.resend": {
		"receipt_ref": "fixture"
	},
	"delivery.cocoon": {
		"until": "2026-01-01T00:00:00Z"
	}
} as const satisfies Record<OpName, unknown>;

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function opDef(op: string): OpDef | undefined { return (OPS as Record<string, OpDef>)[op]; }
export function canSeeOp(op: OpDef, lanes: string[]): boolean { return lanes.includes(op.lane); }
/** @public Validate operation arguments against the canonical catalog schema. */
export function validateOpArgs(op: string, args: unknown): ValidationResult {
	const def = opDef(op);
	if (!def) return { valid: false, errors: [`Unknown operation: ${op}`] };
	const error = validateJsonSchema(args, def.args);
	return { valid: error === null, errors: error === null ? [] : [error] };
}
