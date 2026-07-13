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
	"stats.query": {
		op: "stats.query",
		verb: "Re-run",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"viz.render": {
		op: "viz.render",
		verb: "Regenerate",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"dashboard.save": {
		op: "dashboard.save",
		verb: "Save",
		lane: "viewer",
		executor: "library",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"dashboard.load": {
		op: "dashboard.load",
		verb: "Load",
		lane: "viewer",
		executor: "library",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"dashboard.delete": {
		op: "dashboard.delete",
		verb: "Delete",
		lane: "viewer",
		executor: "library",
		confirm: "soft",
		undo: true,
		humanOnly: false,
	},
	"agent.restart": {
		op: "agent.restart",
		verb: "Restart",
		lane: "operator",
		executor: "manager",
		confirm: "soft",
		undo: false,
		humanOnly: false,
	},
	"task.dispatch": {
		op: "task.dispatch",
		verb: "Dispatch",
		lane: "operator",
		executor: "dispatcher",
		confirm: "none",
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
	"term.attach": {
		op: "term.attach",
		verb: "Attach",
		lane: "term_admin",
		executor: "pty",
		confirm: "none",
		undo: false,
		humanOnly: true,
	},
	"term.detach": {
		op: "term.detach",
		verb: "Detach",
		lane: "term_admin",
		executor: "pty",
		confirm: "none",
		undo: false,
		humanOnly: true,
	},
	"agent.stop": {
		op: "agent.stop",
		verb: "Stop",
		lane: "operator",
		executor: "manager",
		confirm: "none",
		undo: false,
		humanOnly: false,
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
	"updates.check": {
		op: "updates.check",
		verb: "Check now",
		lane: "operator",
		executor: "box-agent",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"updates.approve": {
		op: "updates.approve",
		verb: "Approve",
		lane: "operator",
		executor: "console-api",
		confirm: "none",
		undo: true,
		humanOnly: false,
	},
	"updates.apply": {
		op: "updates.apply",
		verb: "Apply now",
		lane: "operator",
		executor: "box-agent",
		confirm: "soft",
		undo: false,
		humanOnly: false,
	},
	"host.reboot": {
		op: "host.reboot",
		verb: "Reboot",
		lane: "admin",
		executor: "box-agent",
		confirm: "hard",
		undo: false,
		humanOnly: false,
	},
	"edge.enroll.approve": {
		op: "edge.enroll.approve",
		verb: "Approve enrollment",
		lane: "admin",
		executor: "control-plane",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"edge.enroll.deny": {
		op: "edge.enroll.deny",
		verb: "Deny",
		lane: "admin",
		executor: "edge",
		confirm: "soft",
		undo: false,
		humanOnly: false,
	},
	"doorman.session.drop": {
		op: "doorman.session.drop",
		verb: "Drop session",
		lane: "admin",
		executor: "edge",
		confirm: "soft",
		undo: false,
		humanOnly: false,
	},
	"doorman.redial": {
		op: "doorman.redial",
		verb: "Redial",
		lane: "admin",
		executor: "manager",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"subscription.set": {
		op: "subscription.set",
		verb: "Save",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"subscription.remove": {
		op: "subscription.remove",
		verb: "Remove",
		lane: "viewer",
		executor: "console-api",
		confirm: "soft",
		undo: false,
		humanOnly: false,
	},
	"card.repost": {
		op: "card.repost",
		verb: "Re-post",
		lane: "operator",
		executor: "dispatcher",
		confirm: "soft",
		undo: false,
		humanOnly: false,
	},
	"card.park": {
		op: "card.park",
		verb: "Park",
		lane: "operator",
		executor: "dispatcher",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"delivery.test": {
		op: "delivery.test",
		verb: "Send a test",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"delivery.set_target": {
		op: "delivery.set_target",
		verb: "Change target",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"delivery.resend": {
		op: "delivery.resend",
		verb: "Resend",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: false,
		humanOnly: false,
	},
	"delivery.cocoon": {
		op: "delivery.cocoon",
		verb: "Until 07:00",
		lane: "viewer",
		executor: "console-api",
		confirm: "none",
		undo: true,
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
