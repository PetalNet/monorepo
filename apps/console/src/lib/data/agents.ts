/**
 * Agents surface view-model — assembles the Roster from /roster (a server-side join) and the fleet
 * summary for the FleetStrip. In mock mode it reads fixtures; live mode reads /roster + governance
 * and applies the shared derivations. Lanes and health are computed once here (§6.4).
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
	lanes: RosterLanes;
	health: FleetHealth;
	summary: mock.FleetSummary;
	total: number;
}

function assemble(roster: RosterItem[], summary: mock.FleetSummary, now: number): AgentsData {
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
	return { connected: true, lanes, health, summary, total: roster.length };
}

/** Live-mode placeholder until /roster is wired against the running console-api. */
export function liveEmptyAgents(): AgentsData {
	return {
		connected: false,
		lanes: { needs: [], working: [], idle: [] },
		health: { alive: 0, working: 0, idle: 0, down: 0 },
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
	return assemble(mock.roster, mock.fleetSummary, Date.now());
}
