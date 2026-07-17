import { browser } from "$app/env";
import type { GovernancePool, HeartbeatItem, RosterItem } from "$lib/api/types";
import { assembleAgents, mockAgents, mockArchitects, type AgentsData } from "$lib/data/agents";
import { dataMode, readGovernance, readHeartbeats, readRoster } from "$lib/rpc/browser";

import type { PageLoad } from "./$types";

/**
 * Agents surface data (04-agents §6): the source-preserving Roster join, governance fleet summary,
 * and manager heartbeats. Each live source fails independently and retains its browser snapshot.
 */
let cachedRoster: RosterItem[] | undefined;
let cachedHeartbeats: HeartbeatItem[] | undefined;
let cachedPool: GovernancePool | undefined;
let cachedGovernance: Awaited<ReturnType<typeof readGovernance>>["items"] | undefined;

export const load: PageLoad = async ({
	fetch,
}): Promise<{
	agents: AgentsData;
	architects: HeartbeatItem[];
	sources: Record<"roster" | "governance" | "managers", "live" | "stale" | "unavailable">;
}> => {
	if (dataMode() !== "live")
		return {
			agents: mockAgents(),
			architects: mockArchitects(),
			sources: { roster: "live", governance: "live", managers: "live" },
		};
	const [rosterRead, governanceRead, heartbeatRead] = await Promise.all([
		readRoster(fetch).catch(() => null),
		readGovernance(fetch).catch(() => null),
		readHeartbeats(fetch).catch(() => null),
	]);
	if (browser) {
		if (rosterRead) cachedRoster = rosterRead.items;
		if (governanceRead?.pool) cachedPool = governanceRead.pool;
		if (governanceRead) cachedGovernance = governanceRead.items;
		if (heartbeatRead) cachedHeartbeats = heartbeatRead.items;
	}
	const roster = rosterRead?.items ?? (browser ? cachedRoster : undefined) ?? [];
	const pool = governanceRead?.pool ?? (browser ? cachedPool : undefined);
	const governanceItems = governanceRead?.items ?? (browser ? cachedGovernance : undefined) ?? [];
	const tokensSpent =
		pool?.pool_spent ?? governanceItems.reduce((sum, item) => sum + item.tokens_spent, 0);
	const tokensGranted =
		pool?.pool_tokens ?? governanceItems.reduce((sum, item) => sum + (item.granted_tokens ?? 0), 0);
	return {
		agents: {
			...assembleAgents(roster, {
				tokensSpent,
				tokensGranted: Math.max(tokensGranted, 1),
				mode: pool?.fleet_mode ?? "parallel",
				modeReason: pool?.cascade_active ? "cascade active" : null,
				disciplineOffTask: 0,
				disciplineNote: null,
			}),
			connected: Boolean(
				rosterRead ||
				governanceRead ||
				heartbeatRead ||
				cachedRoster ||
				cachedGovernance ||
				cachedHeartbeats,
			),
		},
		architects: heartbeatRead?.items ?? (browser ? cachedHeartbeats : undefined) ?? [],
		sources: {
			roster: rosterRead ? "live" : cachedRoster ? "stale" : "unavailable",
			governance: governanceRead ? "live" : cachedGovernance ? "stale" : "unavailable",
			managers: heartbeatRead ? "live" : cachedHeartbeats ? "stale" : "unavailable",
		},
	};
};
