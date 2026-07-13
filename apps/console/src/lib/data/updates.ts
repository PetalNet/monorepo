/**
 * Updates & Security view-model (09-updates): the Reboots board over /box-updates. A null count is
 * NOT a zero (honesty rule) — kept as null and rendered "—". Board sort is trouble-first and
 * deterministic (calm surface): can't-collect → overdue → pending (by security desc) → up-to-date,
 * ties by hostname. Mock-default; live reads /box-updates.
 */
import { livenessFromIso } from "$lib/api/derive";
import type { BoxUpdateItem } from "$lib/api/types";

import * as mock from "./mock";

export type ApplyMode = "auto" | "staged-approval" | "manual-notify-only";

export interface UpdateRowView {
	boxId: string;
	host: string;
	status: BoxUpdateItem["status"];
	/** Stale = last_checked past its window; a stale "up to date" is not fine. */
	stale: boolean;
	pending: number | null;
	securityCritical: number | null;
	vulns: number | null;
	rebootRequired: boolean | null;
	applyMode: ApplyMode | null;
	lastChecked: string | null;
	lastApplied: string | null;
	source: string;
	agentless: boolean;
}

export interface UpdatesData {
	connected: boolean;
	rows: UpdateRowView[];
	hud: { securityCritical: number; owing: number; reboots: number };
	/**
	 * True when a box's security count is unknown (null) — "nothing critical" is then unprovable, so
	 * the surface must not render the green fine line.
	 */
	securityUnknown: boolean;
	/** Null when nothing critical; else the honest remainder tail. */
	remainder: string | null;
}

// As-built apply mode per host (agent-malleable, §7.11) until the collector
// serves it on the row. Same documented-inventory pattern as hosts CONTAINERS.
const APPLY_MODE: Record<string, ApplyMode> = {
	".202": "auto",
	".14": "staged-approval",
	".15": "manual-notify-only",
};

const SORT_RANK: Record<BoxUpdateItem["status"], number> = {
	error_collecting: 0,
	updates_overdue: 1,
	updates_pending: 2,
	up_to_date: 3,
};

function assemble(boxUpdates: BoxUpdateItem[], now: number): UpdatesData {
	const rows: UpdateRowView[] = boxUpdates.map((b) => {
		const lastChecked = b.last_checked_at ?? b.updated_at;
		return {
			boxId: b.box_id,
			host: b.hostname,
			status: b.status,
			stale: livenessFromIso(lastChecked, now) === "down",
			pending: b.pending_updates_count ?? null,
			securityCritical: b.security_critical_count ?? null,
			vulns: b.vuln_count ?? null,
			rebootRequired: b.reboot_required == null ? null : b.reboot_required === 1,
			applyMode: b.apply_mode ?? APPLY_MODE[b.hostname] ?? null,
			lastChecked,
			lastApplied: b.last_applied_at ?? null,
			source: b.source_tool,
			agentless: b.agent_vs_agentless === "agentless",
		};
	});
	rows.sort(
		(a, x) =>
			SORT_RANK[a.status] - SORT_RANK[x.status] ||
			(x.securityCritical ?? 0) - (a.securityCritical ?? 0) ||
			a.host.localeCompare(x.host),
	);
	const securityCritical = rows.reduce((n, r) => n + (r.securityCritical ?? 0), 0);
	// A null security count is UNKNOWN, not zero — "nothing critical" is unprovable.
	const securityUnknown = rows.some((r) => r.securityCritical == null);
	// Owed = KNOWN-owed only (pending/overdue). error_collecting means the count is
	// unknowable, not that updates are owed — it lives in the "not verified" signal.
	const owing = rows.filter(
		(r) => r.status === "updates_pending" || r.status === "updates_overdue",
	).length;
	const reboots = rows.filter((r) => r.rebootRequired === true).length;
	const parts: string[] = [];
	if (owing > 0) parts.push(`${owing} host${owing === 1 ? "" : "s"} owe updates`);
	const notVerified = rows
		.filter((r) => r.stale || r.status === "error_collecting")
		.map((r) => r.host);
	if (notVerified.length) parts.push(`${notVerified.join(", ")} not verified`);
	return {
		connected: true,
		rows,
		hud: { securityCritical, owing, reboots },
		securityUnknown,
		remainder: parts.length ? parts.join(" · ") : null,
	};
}

export function liveEmptyUpdates(): UpdatesData {
	return {
		connected: false,
		rows: [],
		hud: { securityCritical: 0, owing: 0, reboots: 0 },
		securityUnknown: false,
		remainder: null,
	};
}

export function mockUpdates(): UpdatesData {
	return assemble(mock.boxUpdates, Date.now());
}
