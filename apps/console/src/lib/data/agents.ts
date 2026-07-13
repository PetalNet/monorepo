/**
 * Agents surface view-model — assembles the Roster from /roster (a server-side join) and the fleet
 * summary for the FleetStrip. In mock mode it reads fixtures; live mode reads /roster + governance
 * and applies the shared derivations. The raw roster is retained so time-derived lanes and health
 * can be recomputed from the live UI clock (§6.4).
 */
import { isRosterDown, rosterLane, rosterState } from "$lib/api/derive";
import type { RosterItem } from "$lib/api/types";

import * as mock from "./mock";

export interface RosterLanes {
	needs: RosterItem[];
	working: RosterItem[];
	idle: RosterItem[];
}
export interface FleetHealth {
	alive: number;
	working: number;
	idle: number;
	down: number;
}
export interface AgentsData {
	connected: boolean;
	roster: RosterItem[];
	summary: mock.FleetSummary;
	total: number;
}

export function deriveRoster(
	roster: RosterItem[],
	now: number,
): {
	lanes: RosterLanes;
	health: FleetHealth;
} {
	const lanes: RosterLanes = { needs: [], working: [], idle: [] };
	const health: FleetHealth = { alive: 0, working: 0, idle: 0, down: 0 };
	for (const row of roster) {
		const state = rosterState(row, now);
		lanes[rosterLane(state)].push(row);
		if (isRosterDown(state)) health.down++;
		else if (state === "working") health.working++;
		else if (state === "alive") health.alive++;
		else health.idle++;
	}
	return { lanes, health };
}

function assemble(roster: RosterItem[], summary: mock.FleetSummary): AgentsData {
	return { connected: true, roster, summary, total: roster.length };
}

/** Live-mode placeholder until /roster is wired against the running console-api. */
export function liveEmptyAgents(): AgentsData {
	return {
		connected: false,
		roster: [],
		summary: {
			tokensSpent: 0,
			tokensGranted: 1,
			mode: "parallel",
			modeReason: null,
			disciplineOffTask: 0,
			disciplineNote: null,
		},
		total: 0,
	};
}

export function mockAgents(): AgentsData {
	return assemble(mock.roster, mock.fleetSummary);
}
