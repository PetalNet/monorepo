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
import type { BoxUpdateItem, RegistryItem, RosterItem, WorkerItem } from "$lib/api/types";

import * as mock from "./mock";

export type HostLiveness = "up" | "degraded" | "down";

export interface HostView {
	host: string;
	liveness: HostLiveness;
	residents: string[];
	workersUp: number;
	/** Container inventory is not exposed by the contracted live reads yet. */
	containers: number | null;
	updateStatus: BoxUpdateItem["status"] | null;
	securityCritical: number | null;
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
	boxUpdatedAt: string | null,
	regRows: RegistryItem[],
	rosterRows: RosterItem[],
	workerRows: WorkerItem[],
	anyResidentDown: boolean,
	now: number,
): HostLiveness {
	const signals: Liveness[] = boxUpdatedAt ? [livenessFromIso(boxUpdatedAt, now)] : [];
	for (const r of regRows) {
		const l = livenessFromEpoch(r.last_seen_epoch, now);
		if (l) signals.push(l);
	}
	for (const resident of rosterRows) {
		if (resident.fleet_updated_at) signals.push(livenessFromIso(resident.fleet_updated_at, now));
	}
	for (const worker of workerRows) signals.push(livenessFromIso(worker.updated_at, now));
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
	hud: { housesUp: number; residents: number; containers: number | null };
}

// Mock-only container inventory. Live reads do not contract a container count, so they render unknown.
const MOCK_CONTAINERS: Record<string, number> = { ".202": 14, ".14": 9, ".15": 6, mc34: 3 };

export function assembleHosts(
	boxUpdates: BoxUpdateItem[],
	roster: RosterItem[],
	registry: RegistryItem[],
	workers: WorkerItem[],
	now: number,
	containerInventory?: Record<string, number>,
): HostsData {
	const hostNames = new Set([
		...boxUpdates.map((item) => item.hostname),
		...roster.flatMap((item) => (item.host ? [item.host] : [])),
		...registry.flatMap((item) => (item.host ? [item.host] : [])),
		...workers.map((item) => item.host),
	]);
	const hosts: HostView[] = [...hostNames].toSorted().map((host) => {
		const box = boxUpdates.find((item) => item.hostname === host);
		const onBox = roster.filter((item) => item.host === host);
		const regRows = registry.filter((item) => item.host === host);
		const workerRows = workers.filter((item) => item.host === host);
		const anyDown = onBox.some((r) => isRosterDown(rosterState(r, now)));
		const workersUp = workerRows.filter(
			(worker) => now - Date.parse(worker.updated_at) <= 90_000,
		).length;
		const secCrit = box?.security_critical_count ?? null;
		let liveness = hostLiveness(box?.updated_at ?? null, regRows, onBox, workerRows, anyDown, now);
		if (liveness === "up" && ((secCrit ?? 0) > 0 || box?.status === "error_collecting"))
			liveness = "degraded";
		// Quiet = up AND up-to-date: the positive-evidence "everything is fine" line
		// must never contradict a card showing pending/overdue updates.
		const quiet = liveness === "up" && box?.status === "up_to_date";
		return {
			host,
			liveness,
			residents: onBox.map((r) => r.handle),
			workersUp,
			containers: containerInventory?.[host] ?? null,
			updateStatus: box?.status ?? null,
			securityCritical: secCrit,
			rebootRequired: box?.reboot_required === 1,
			quiet,
		};
	});
	return {
		connected: true,
		hosts,
		hud: {
			housesUp: hosts.filter((h) => h.liveness !== "down").length,
			residents: roster.length,
			containers: containerInventory ? hosts.reduce((n, h) => n + (h.containers ?? 0), 0) : null,
		},
	};
}

export function mockHosts(): HostsData {
	const mockWorkers: WorkerItem[] = mock.roster.flatMap((row) =>
		Array.from({ length: row.workers_active }, (_, index) => ({
			handle: row.handle,
			host: row.host ?? "unknown",
			label: `worker-${String(index + 1)}`,
			started_at: row.started_at ?? row.updated_at,
			updated_at: row.updated_at,
		})),
	);
	return assembleHosts(
		mock.boxUpdates,
		mock.roster,
		mock.registry,
		mockWorkers,
		Date.now(),
		MOCK_CONTAINERS,
	);
}
