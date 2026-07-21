/**
 * Shared client derivations named in foundations §6.3/§6.4 — computed once here, NEVER re-derived
 * per surface. The UI computes staleness, it never trusts it (Rule 10): silence never renders as
 * health. This is the shell's subset; each surface adds only derivations that are not shared.
 */
import type {
	AttentionGrade,
	AttentionItem,
	ConsoleHealth,
	FleetItem,
	RosterItem,
	SignalSeverity,
} from "./types";

export type SignalSeverityLabel = "P0" | "P1" | "P2" | "P3" | "feed only";

/** Canonical operator grade for every accepted signal severity (contracts §8). */
const SIGNAL_SEVERITY_LABELS = {
	p0: "P0",
	danger: "P1",
	warn: "P2",
	info: "P3",
	debug: "feed only",
} as const satisfies Record<SignalSeverity, SignalSeverityLabel>;

export function signalSeverityLabel(severity: SignalSeverity): SignalSeverityLabel {
	return SIGNAL_SEVERITY_LABELS[severity];
}

export interface RosterSource {
	visibility: "visible" | "absent" | "unavailable";
	observed_at?: string | null;
	data?: Record<string, unknown> | null;
}
export interface JoinedRosterItem extends Record<string, unknown> {
	handle: string;
	workers_active?: number;
	fleet: RosterSource;
	heartbeat: RosterSource;
	registry: RosterSource;
	governance: RosterSource;
	identity: RosterSource;
	lease: RosterSource;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Adapt the source-preserving `/roster` join to the stable row consumed by roster renderers. */
export function flattenRosterItem(row: JoinedRosterItem): RosterItem {
	const fleet = row.fleet.data ?? {};
	const heartbeat = row.heartbeat.data ?? {};
	const registry = row.registry.data ?? {};
	const governance = row.governance.data ?? {};
	const identity = row.identity.data ?? {};
	const lease = row.lease.data ?? {};
	const clocks = [
		row.fleet.observed_at,
		row.heartbeat.observed_at,
		row.registry.observed_at,
		row.governance.observed_at,
	].filter((clock): clock is string => typeof clock === "string");
	const newestClock =
		clocks.toSorted((a, b) => Date.parse(b) - Date.parse(a))[0] ?? new Date(0).toISOString();
	const channelLock = heartbeat["channel_lock"];
	return {
		handle: row.handle,
		host:
			stringValue(fleet["host"]) ?? stringValue(registry["host"]) ?? stringValue(identity["host"]),
		status: (stringValue(fleet["status"]) as RosterItem["status"]) ?? null,
		current_tool: stringValue(fleet["current_tool"]),
		task_id: numberValue(fleet["task_id"]) ?? numberValue(lease["task_id"]),
		task_title: stringValue(lease["task_title"]),
		heartbeat_state: (stringValue(heartbeat["state"]) as RosterItem["heartbeat_state"]) ?? null,
		crash_count: numberValue(heartbeat["crash_count"]),
		channel_lock_state:
			channelLock && typeof channelLock === "object" && !Array.isArray(channelLock)
				? ((stringValue(
						(channelLock as Record<string, unknown>)["state"],
					) as RosterItem["channel_lock_state"]) ?? null)
				: null,
		autonomy: (stringValue(identity["autonomy"]) as RosterItem["autonomy"]) ?? null,
		lane: stringValue(identity["lane"]),
		light: (stringValue(governance["light"]) as RosterItem["light"]) ?? null,
		tokens_spent: numberValue(governance["tokens_spent"]),
		tier: stringValue(governance["tier"]),
		lease_expires_at: stringValue(lease["lease_expires_at"]),
		fence: numberValue(lease["fence"]),
		workers_active: numberValue(row.workers_active) ?? 0,
		updated_at: newestClock,
		observed_at: newestClock,
		fleet_updated_at: stringValue(fleet["updated_at"]),
		started_at: stringValue(fleet["started_at"]),
		registry_last_seen_epoch: numberValue(registry["last_seen_epoch"]),
		sources: Object.fromEntries(
			(["fleet", "heartbeat", "registry", "governance", "identity", "lease"] as const).map(
				(key) => [
					key,
					{ visibility: row[key].visibility, observed_at: row[key].observed_at ?? null },
				],
			),
		) as RosterItem["sources"],
	};
}

/** Age of the freshest explicit live bridge proof; null means the health read cannot prove it. */
export function consoleHealthBusAgeS(health: ConsoleHealth, now = Date.now()): number | null {
	const ages = health.bridges.flatMap((bridge) => {
		if (!bridge || typeof bridge !== "object" || Array.isArray(bridge)) return [];
		const item = bridge as Record<string, unknown>;
		for (const key of ["observed_at", "last_seen_at"]) {
			const value = item[key];
			if (typeof value === "string" && Number.isFinite(Date.parse(value)))
				return [(now - Date.parse(value)) / 1_000];
		}
		const epoch = item["last_seen_epoch"];
		if (typeof epoch === "number" && Number.isFinite(epoch)) return [now / 1_000 - epoch];
		return item["state"] === "up" || item["status"] === "ok" || item["liveness"] === "alive"
			? [0]
			: [];
	});
	return ages.length ? Math.min(...ages) : null;
}

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
function livenessFromAge(ageSec: number): Liveness {
	if (ageSec > WINDOW.registryDown) return "down";
	if (ageSec > WINDOW.registrySuspect) return "suspect";
	return "alive";
}
/** Liveness from an epoch-seconds last-seen (90/300s); null when unknown. */
export function livenessFromEpoch(
	epoch: number | null | undefined,
	now = Date.now(),
): Liveness | null {
	return epoch == null ? null : livenessFromAge(ageEpochS(epoch, now));
}
/** Liveness from an RFC 3339 last-update timestamp (90/300s). */
export function livenessFromIso(ts: string, now = Date.now()): Liveness {
	return livenessFromAge(ageS(ts, now));
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

// Roster (GET /roster) derivations — the Agents surface. Presence merges the
// fleet status with the heartbeat state and staleness; a gone-quiet resident
// counts as down, never alive (§7), while keeping its lane slot.
export type RosterState =
	| "working"
	| "alive"
	| "idle"
	| "rate_limited"
	| "waiting"
	| "crashed"
	| "stopped"
	| "paused"
	| "gone_quiet";
export type RosterLane = "needs" | "working" | "idle";

export function rosterState(row: RosterItem, now = Date.now()): RosterState {
	if (row.autonomy === "paused") return "paused";
	const hb = row.heartbeat_state;
	if (hb === "crashed") return "crashed";
	if (hb === "stopped") return "stopped";
	if (hb === "rate_limited") return "rate_limited";
	if (hb === "waiting") return "waiting";
	// gone-quiet is derived from the FLEET clock (never the join time), §6.2.
	const fleetClock = row.fleet_updated_at ?? row.updated_at;
	if (row.status && ageS(fleetClock, now) > WINDOW.fleetSnapshot) return "gone_quiet";
	if (row.status === "working") return "working";
	if (row.status === "idle") return "idle";
	if (row.status === "alive") return "alive";
	// No fleet row (registry stub): liveness from the capacity clock.
	if (row.registry_last_seen_epoch != null) {
		return ageEpochS(row.registry_last_seen_epoch, now) > WINDOW.registryDown
			? "gone_quiet"
			: "idle";
	}
	return "idle";
}

/** Down = gone-quiet ∪ crashed/stopped (§3.1 health zone). */
export function isRosterDown(state: RosterState): boolean {
	return state === "gone_quiet" || state === "crashed" || state === "stopped";
}

/** Lane assignment: needs-you states float to the top lane (§2). */
export function rosterLane(state: RosterState): RosterLane {
	if (isRosterDown(state) || state === "rate_limited" || state === "waiting") return "needs";
	if (state === "working") return "working";
	return "idle";
}

export type Tone = "good" | "warn" | "danger" | "info" | "idle";
export function rosterTone(state: RosterState): Tone {
	switch (state) {
		case "working":
		case "alive":
			return "good";
		case "rate_limited":
		case "waiting":
			return "warn";
		case "crashed":
		case "stopped":
			return "danger";
		default:
			return "idle";
	}
}

/** Human-facing "Ns" / "Nm" / "Nh" age. */
export function humanAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${String(s)}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${String(m)}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${String(h)}h`;
	return `${String(Math.round(h / 24))}d`;
}
