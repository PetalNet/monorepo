/**
 * Updates & Security view-model (09-updates): the Reboots board over /box-updates. A null count is
 * NOT a zero (honesty rule) — kept as null and rendered "—". Board sort is trouble-first and
 * deterministic (calm surface): can't-collect → overdue → pending (by security desc) → up-to-date,
 * ties by hostname. Mock-default; live reads /box-updates.
 */
import type { BoxUpdateItem, BoxUpdateRaw } from "$lib/api/types";

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
	hud: { securityCritical: number | null; owing: number; reboots: number | null };
	/**
	 * True when a box's security count is unknown (null) — "nothing critical" is then unprovable, so
	 * the surface must not render the green fine line.
	 */
	securityUnknown: boolean;
	/** Null when nothing critical; else the honest remainder tail. */
	remainder: string | null;
	freshness: { source: string; observedAt: string; windowS: number | null } | null;
	truncated: boolean;
	executorLiveHosts: string[];
	lanes: string[];
}

// As-built apply mode per host (agent-malleable, §7.11) until the collector
// serves it on the row. Same documented-inventory pattern as hosts CONTAINERS.
const MOCK_APPLY_MODE: Record<string, ApplyMode> = {
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

interface AssembleOptions {
	now: number;
	windowS?: number | null;
	freshnessSource?: string;
	freshnessObservedAt?: string;
	truncated?: boolean;
	executorLiveHosts?: string[];
	lanes?: string[];
	mockApplyModes?: boolean;
}

export function assembleUpdates(boxUpdates: BoxUpdateItem[], opts: AssembleOptions): UpdatesData {
	const windowS = opts.windowS === undefined ? 86_400 : opts.windowS;
	const rows: UpdateRowView[] = boxUpdates.map((b) => {
		const lastChecked = b.last_checked_at ?? null;
		const checkedAt = lastChecked ? Date.parse(lastChecked) : Number.NaN;
		return {
			boxId: b.box_id,
			host: b.hostname,
			status: b.status,
			stale:
				windowS === null || !Number.isFinite(checkedAt) || opts.now - checkedAt > windowS * 1000,
			pending: b.pending_updates_count ?? null,
			securityCritical: b.security_critical_count ?? null,
			vulns: b.vuln_count ?? null,
			rebootRequired: b.reboot_required == null ? null : b.reboot_required === 1,
			applyMode:
				b.apply_mode ?? (opts.mockApplyModes ? (MOCK_APPLY_MODE[b.hostname] ?? null) : null),
			lastChecked,
			lastApplied: b.last_applied_at ?? null,
			source: b.source_tool,
			agentless: b.agent_vs_agentless === "agentless",
		};
	});
	rows.sort(
		(a, x) =>
			Number(x.stale || x.status === "error_collecting") -
				Number(a.stale || a.status === "error_collecting") ||
			SORT_RANK[a.status] - SORT_RANK[x.status] ||
			(x.securityCritical ?? 0) - (a.securityCritical ?? 0) ||
			a.host.localeCompare(x.host),
	);
	const securityCritical = rows.some((r) => r.securityCritical == null)
		? null
		: rows.reduce((n, r) => n + (r.securityCritical ?? 0), 0);
	// A null security count is UNKNOWN, not zero — "nothing critical" is unprovable.
	const securityUnknown = rows.some((r) => r.securityCritical == null);
	// Owed = KNOWN-owed only (pending/overdue). error_collecting means the count is
	// unknowable, not that updates are owed — it lives in the "not verified" signal.
	const owing = rows.filter((r) => r.status !== "up_to_date").length;
	const reboots = rows.some((r) => r.rebootRequired == null)
		? null
		: rows.filter((r) => r.rebootRequired === true).length;
	const parts: string[] = [];
	if (owing > 0) parts.push(`${String(owing)} host${owing === 1 ? "" : "s"} owe updates`);
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
		freshness: opts.freshnessObservedAt
			? {
					source: opts.freshnessSource ?? "unknown",
					observedAt: opts.freshnessObservedAt,
					windowS,
				}
			: null,
		truncated: opts.truncated ?? false,
		executorLiveHosts: opts.executorLiveHosts ?? [],
		lanes: opts.lanes ?? [],
	};
}

export function liveEmptyUpdates(): UpdatesData {
	return {
		connected: false,
		rows: [],
		hud: { securityCritical: null, owing: 0, reboots: null },
		securityUnknown: false,
		remainder: null,
		freshness: null,
		truncated: false,
		executorLiveHosts: [],
		lanes: [],
	};
}

export function mockUpdates(lanes: string[] = ["viewer", "operator", "admin"]): UpdatesData {
	return assembleUpdates(mock.boxUpdates, {
		now: Date.now(),
		windowS: 86_400,
		freshnessSource: "mock collector",
		freshnessObservedAt: new Date().toISOString(),
		executorLiveHosts: [".202", ".14", ".15"],
		lanes,
		mockApplyModes: true,
	});
}

export function mockRawUpdate(boxId: string): BoxUpdateRaw {
	return {
		box_id: boxId,
		collected_at: new Date(Date.now() - 120_000).toISOString(),
		packages:
			boxId === "a1:15"
				? [
						{ name: "openssl", from: "3.0.13", to: "3.0.16", security: true },
						{ name: "curl", from: "8.5.0", to: "8.7.1", security: false },
					]
				: [{ name: "tzdata", from: "2025a", to: "2026a", security: false }],
		vulns:
			boxId === "a1:15"
				? [
						{
							cve_id: "CVE-2026-4189",
							severity: "critical",
							package: "openssl",
							fixed_in: "3.0.16",
						},
					]
				: [],
	};
}
