/**
 * Hosts surface view-model (07-hosts): one house per box, joining box-update posture + the
 * residents living there (from /roster) + capacity liveness. The grid is a renderer over the
 * substrate; a spatial view layers on later with no re-wiring (/task/690). Mock mode joins
 * fixtures; live joins /box-updates + /roster + /registry.
 */
import {
	isRosterDown,
	livenessFromEpoch,
	livenessFromIso,
	rosterState,
	type Liveness,
} from "$lib/api/derive";
import type { BoxUpdateItem, RegistryItem, RosterItem } from "$lib/api/types";

import * as mock from "./mock";

export type HostLiveness = "up" | "degraded" | "down";

export interface HostView {
	host: string;
	liveness: HostLiveness;
	residents: string[];
	workersUp: number;
	containers: number;
	updateStatus: BoxUpdateItem["status"];
	securityCritical: number;
	rebootRequired: boolean;
	/** True when nothing is owed AND nothing is stale — the positive-evidence quiet. */
	quiet: boolean;
}

/**
 * Freshest liveness across a host's own signals: its box-update collection and the
 * capacity-registry last-seen of any resident. A stale collection on an agentless box (no
 * residents) makes the host DOWN, never silently up.
 */
function hostLiveness(
	boxUpdatedAt: string,
	regRows: RegistryItem[],
	anyResidentDown: boolean,
	now: number,
): HostLiveness {
	const signals: Liveness[] = [livenessFromIso(boxUpdatedAt, now)];
	for (const r of regRows) {
		const l = livenessFromEpoch(r.last_seen_epoch, now);
		if (l) signals.push(l);
	}
	// The freshest signal wins (any live source proves the box answers).
	const best = signals.includes("alive")
		? "alive"
		: signals.includes("suspect")
			? "suspect"
			: "down";
	if (best === "down") return "down";
	if (best === "suspect" || anyResidentDown) return "degraded";
	return "up";
}

export interface HostsData {
	connected: boolean;
	hosts: HostView[];
	hud: { housesUp: number; residents: number; containers: number };
}

// Container counts per box (as-built inventory; a Phase-1 read replaces this).
const CONTAINERS: Record<string, number> = { ".202": 14, ".14": 9, ".15": 6, mc34: 3 };

function assemble(
	boxUpdates: BoxUpdateItem[],
	roster: RosterItem[],
	registry: RegistryItem[],
	now: number,
): HostsData {
	const hosts: HostView[] = boxUpdates.map((b) => {
		const onBox = roster.filter((r) => r.host === b.hostname);
		const regRows = registry.filter((r) => r.host === b.hostname);
		const anyDown = onBox.some((r) => isRosterDown(rosterState(r, now)));
		const workersUp = onBox.filter((r) => rosterState(r, now) === "working").length;
		const secCrit = b.security_critical_count ?? 0;
		let liveness = hostLiveness(b.updated_at, regRows, anyDown, now);
		if (liveness === "up" && (secCrit > 0 || b.status === "error_collecting"))
			liveness = "degraded";
		// Quiet = up AND up-to-date: the positive-evidence "everything is fine" line
		// must never contradict a card showing pending/overdue updates.
		const quiet = liveness === "up" && b.status === "up_to_date";
		return {
			host: b.hostname,
			liveness,
			residents: onBox.map((r) => r.handle),
			workersUp,
			containers: CONTAINERS[b.hostname] ?? 0,
			updateStatus: b.status,
			securityCritical: secCrit,
			rebootRequired: b.reboot_required === 1,
			quiet,
		};
	});
	return {
		connected: true,
		hosts,
		hud: {
			housesUp: hosts.filter((h) => h.liveness !== "down").length,
			residents: roster.length,
			containers: hosts.reduce((n, h) => n + h.containers, 0),
		},
	};
}

export function liveEmptyHosts(): HostsData {
	return { connected: false, hosts: [], hud: { housesUp: 0, residents: 0, containers: 0 } };
}

export function mockHosts(): HostsData {
	return assemble(mock.boxUpdates, mock.roster, mock.registry, Date.now());
}
