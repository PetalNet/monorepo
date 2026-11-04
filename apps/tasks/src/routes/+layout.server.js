import { getFleet } from "$lib/server/fleet.js";

// Feed the sidebar agent rail with the LIVE per-agent fleet (data/fleet/*.json,
// written by the lifecycle hooks) joined to the task each agent has claimed.
// The old single agent-fleet-status.json heartbeat is retired (see fleet.js).
export function load({ locals }) {
	return { fleet: getFleet(locals.user), user: locals.user };
}
