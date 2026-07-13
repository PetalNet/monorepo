/**
 * Shared client derivations named in foundations §6.3/§6.4 — computed once here, NEVER re-derived
 * per surface. The UI computes staleness, it never trusts it (Rule 10): silence never renders as
 * health. This is the shell's subset; each surface adds the derivations it needs (severity→label,
 * incident collapse, heartbeat freshness) when it lands.
 */
import type { AttentionGrade, AttentionItem, FleetItem, RegistryItem } from "./types";

// Freshness windows (foundations §8, seconds).
const WINDOW = {
	fleetSnapshot: 90,
	registrySuspect: 90,
	registryDown: 300,
	busHeartbeatSilent: 90,
} as const;

/** Ms since an RFC 3339 timestamp, relative to `now` (default Date.now()). */
function ageMs(ts: string, now = Date.now()): number {
	return now - Date.parse(ts);
}
function ageS(ts: string, now = Date.now()): number {
	return ageMs(ts, now) / 1000;
}
function ageEpochS(epoch: number, now = Date.now()): number {
	return now / 1000 - epoch;
}

/** Fleet presence: producers write alive|working|idle; offline is derived (>90s). */
export type Presence = FleetItem["status"] | "offline";
export function fleetPresence(item: FleetItem, now = Date.now()): Presence {
	const freshest = Math.min(ageS(item.updated_at, now), ageS(item.observed_at, now));
	if (freshest > WINDOW.fleetSnapshot) return "offline";
	return item.status;
}

/** Registry liveness, the 90/300 control-plane constants. */
export type Liveness = "alive" | "suspect" | "down";
export function registryLiveness(item: RegistryItem, now = Date.now()): Liveness {
	const age = ageEpochS(item.last_seen_epoch, now);
	if (age > WINDOW.registryDown) return "down";
	if (age > WINDOW.registrySuspect) return "suspect";
	return "alive";
}

// Attention ordering: severity-first, newest within grade (§4.4). Acked items
// dim and sort below new ones.
const GRADE_RANK: Record<AttentionGrade, number> = { p0: 0, blocker: 1, review: 2, artifact: 3 };
export function attentionSort(items: AttentionItem[]): AttentionItem[] {
	return items.toSorted((a, b) => {
		const ackA = a.acked_by ? 1 : 0;
		const ackB = b.acked_by ? 1 : 0;
		if (ackA !== ackB) return ackA - ackB; // new before acked
		if (GRADE_RANK[a.grade] !== GRADE_RANK[b.grade])
			return GRADE_RANK[a.grade] - GRADE_RANK[b.grade];
		return Date.parse(b.ts) - Date.parse(a.ts); // newest first
	});
}

/** An item is "live" (still needs you) when unresolved and not snoozed. */
export function isActiveAttention(item: AttentionItem, now = Date.now()): boolean {
	if (item.resolved_at) return false;
	if (item.snoozed_until && Date.parse(item.snoozed_until) > now) return false;
	return true;
}

// The "everything is fine" positive-evidence check (§4.6). "Fine" requires a
// fresh bus heartbeat AND ingest within windows AND fresh fleet data — all
// three, positive evidence. Silence is "Can't verify", never health.
export interface HealthInputs {
	busHeartbeatAgeS: number | null; // null = never seen a frame
	fleetSnapshotAgeS: number | null;
	activeP0Count: number;
	activeAttentionCount: number;
}
export type HealthVerdict = "fine" | "cracked" | "cant_verify" | "needs_you";
export function healthVerdict(h: HealthInputs): HealthVerdict {
	if (h.activeP0Count > 0) return "cracked";
	const busFresh = h.busHeartbeatAgeS !== null && h.busHeartbeatAgeS <= WINDOW.busHeartbeatSilent;
	const fleetFresh = h.fleetSnapshotAgeS !== null && h.fleetSnapshotAgeS <= WINDOW.fleetSnapshot;
	if (!busFresh || !fleetFresh) return "cant_verify";
	if (h.activeAttentionCount > 0) return "needs_you";
	return "fine";
}

/** Human-facing "Ns" / "Nm" / "Nh" age. */
export function humanAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}
