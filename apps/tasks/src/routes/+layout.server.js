import { tasksConfig } from "$lib/server/config.js";
import { getFleet } from "$lib/server/fleet.js";
import { VOICE_NAMES } from "$lib/server/voices.js";

// Feed the sidebar agent rail with the LIVE per-agent fleet (data/fleet/*.json,
// written by the lifecycle hooks) joined to the task each agent has claimed.
// The old single agent-fleet-status.json heartbeat is retired (see fleet.js).
export function load({ locals }) {
	const { people, assignees, responsibles } = tasksConfig;

	return {
		fleet: getFleet(locals.user),
		user: locals.user,
		config: { people, assignees, responsibles, voices: VOICE_NAMES },
	};
}
