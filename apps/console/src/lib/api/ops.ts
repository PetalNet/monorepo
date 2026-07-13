/**
 * Op catalog — the console subset of console-api's `ops.json` (the CANONICAL catalog). Wire names +
 * lane + confirm/undo mirror ops.json EXACTLY; drift is a bug (the contract generates ActionRows
 * from ops.json — full codegen from the shared catalog is a follow-up, tracked in BLOCKERS.md).
 * Spec-name aliases (e.g. `governance.pause` -> `governance.action{action:pause}`, `terminal.open`
 * -> `term.watch`) are DISPLAY-ONLY and never used as wire names (§5.2). A button exists only if
 * its op exists (§4.2: no op -> no button).
 */
import type { Lane } from "./types";

export type ConfirmKind = "none" | "soft" | "hard";

export interface OpDef {
	/** Exact wire name (ops.json `op`). */
	op: string;
	/** Plain verb rendered on the button; the op name lives in the audit note. */
	verb: string;
	/** Capability lane required (visibility gate; server enforces authz∩lane). */
	lane: Lane;
	/** Gating executor kind (pre-flight liveness per /executors). */
	executor: string;
	confirm: ConfirmKind;
	undo: boolean;
	humanOnly: boolean;
}

const OPS = {
	"agent.restart": {
		op: "agent.restart",
		verb: "Restart",
		lane: "operator",
		executor: "manager",
		confirm: "soft",
		undo: false,
		humanOnly: false,
	},
	"governance.action": {
		op: "governance.action",
		verb: "Pause",
		lane: "operator",
		executor: "control-plane",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"governance.tier": {
		op: "governance.tier",
		verb: "Tier",
		lane: "operator",
		executor: "control-plane",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"signal.snooze": {
		op: "signal.snooze",
		verb: "Quiet 1h",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: true,
		humanOnly: false,
	},
	"attention.ack": {
		op: "attention.ack",
		verb: "Ack",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"attention.snooze": {
		op: "attention.snooze",
		verb: "Snooze",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: true,
		humanOnly: false,
	},
	"attention.resolve": {
		op: "attention.resolve",
		verb: "Done",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"term.watch": {
		op: "term.watch",
		verb: "Watch session",
		lane: "term_admin",
		executor: "pty",
		confirm: "none",
		undo: false,
		humanOnly: true,
	},
	"dashboard.set_home": {
		op: "dashboard.set_home",
		verb: "Set as home",
		lane: "viewer",
		executor: "library",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"dashboard.pin": {
		op: "dashboard.pin",
		verb: "Pin to home",
		lane: "viewer",
		executor: "library",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
} satisfies Record<string, OpDef>;

export function opDef(op: string): OpDef | undefined {
	return (OPS as Record<string, OpDef>)[op];
}

/** Lane-gated visibility: a viewer sees state, not controls (§4.2). */
export function canSeeOp(op: OpDef, lanes: string[]): boolean {
	return lanes.includes(op.lane);
}
