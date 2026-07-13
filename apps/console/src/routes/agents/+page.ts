import { dataMode } from "$lib/api/client";
import { liveEmptyAgents, mockAgents, type AgentsData } from "$lib/data/agents";

import type { PageLoad } from "./$types";

/**
 * Agents surface data (04-agents §6): the Roster from /roster (server-side join) + the fleet
 * summary. Mock-default; live mode reads /roster once it's wired against the running console-api
 * (the read is real on main — see BLOCKERS.md).
 */
export const load: PageLoad = async (): Promise<{ agents: AgentsData }> => {
	return { agents: dataMode() === "live" ? liveEmptyAgents() : mockAgents() };
};
