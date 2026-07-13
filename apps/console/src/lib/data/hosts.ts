/**
 * Hosts surface view-model (07-hosts): one house per box, joining box-update posture + the
 * residents living there (from /roster) + capacity liveness. The grid is a renderer over the
 * substrate; a spatial view layers on later with no re-wiring (/task/690). Mock mode joins
 * fixtures; live joins /box-updates + /roster + /registry.
 */
import { isRosterDown, rosterState } from "$lib/api/derive";
import type { BoxUpdateItem, RosterItem } from "$lib/api/types";

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
}

export interface HostsData {
	connected: boolean;
	hosts: HostView[];
	hud: { housesUp: number; residents: number; containers: number };
}

// Container counts per box (as-built inventory; a Phase-1 read replaces this).
const CONTAINERS: Record<string, number> = { ".202": 14, ".14": 9, ".15": 6, mc34: 3 };

function assemble(boxUpdates: BoxUpdateItem[], roster: RosterItem[], now: number): HostsData {
	const hosts: HostView[] = boxUpdates.map((b) => {
		const onBox = roster.filter((r) => r.host === b.hostname);
		const anyDown = onBox.some((r) => isRosterDown(rosterState(r, now)));
		const workersUp = onBox.filter((r) => rosterState(r, now) === "working").length;
		const liveness: HostLiveness =
			b.status === "error_collecting" || anyDown
				? "degraded"
				: (b.security_critical_count ?? 0) > 0
					? "degraded"
					: "up";
		return {
			host: b.hostname,
			liveness,
			residents: onBox.map((r) => r.handle),
			workersUp,
			containers: CONTAINERS[b.hostname] ?? 0,
			updateStatus: b.status,
			securityCritical: b.security_critical_count ?? 0,
			rebootRequired: b.reboot_required === 1,
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
	return assemble(mock.boxUpdates, mock.roster, Date.now());
}
