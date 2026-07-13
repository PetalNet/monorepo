/**
 * Agents surface view-model — assembles the Roster from /roster (a server-side join) and the fleet
 * summary for the FleetStrip. In mock mode it reads fixtures; live mode reads /roster + governance
 * and applies the shared derivations. The raw roster is retained so time-derived lanes and health
 * can be recomputed from the live UI clock (§6.4).
 */
import { isRosterDown, rosterLane, rosterState } from "../api/derive.ts";
import type { HeartbeatItem, RosterItem } from "../api/types.ts";

import * as mock from "./mock.ts";

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

export function assembleAgents(roster: RosterItem[], summary: mock.FleetSummary): AgentsData {
	return { connected: true, roster, summary, total: roster.length };
}

export function mockAgents(): AgentsData {
	return assembleAgents(mock.roster, mock.fleetSummary);
}

/** Contract-shaped manager heartbeats for the mock lens; live mode always reads `/heartbeats`. */
export function mockArchitects(): HeartbeatItem[] {
	const nowEpoch = Math.floor(Date.now() / 1_000);
	return mock.roster.flatMap((row, index) => {
		if (!row.host || !row.heartbeat_state) return [];
		return [
			{
				schema_version: 2,
				version: "mock-manager",
				handle: row.handle,
				pid: 2_000 + index,
				state: row.heartbeat_state,
				session_id: `mock-${row.handle}`,
				tmux_session: `agent-${row.handle}`,
				pane_id: `%${String(index + 1)}`,
				io_ok: row.channel_lock_state !== "lockout",
				crash_count: row.crash_count ?? 0,
				started_at_epoch: Math.floor(Date.parse(row.started_at ?? row.updated_at) / 1_000),
				last_sync_ok_epoch: nowEpoch - 12,
				updated_at_epoch: nowEpoch - 6,
				host: row.host,
				observed_at: new Date((nowEpoch - 6) * 1_000).toISOString(),
			},
		];
	});
}
