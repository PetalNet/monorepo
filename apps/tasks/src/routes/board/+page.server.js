import { boardData, listProjects, deepScrub } from "$lib/server/db.js";

// /board — the fleet at a glance (fleet-dispatcher Phase 2, #242). Read-only.
// boardData pre-derives lease_age_s / lease_state on the server (handy, avoids
// client clock skew). deepScrub now strips only claim_token, so lease_expires_at
// + claimed_by reach the UI fine — they aren't secrets.
export function load({ locals }) {
	const me = locals.user;

	return deepScrub({
		...boardData(me),
		projects: listProjects(me), // for project-name lookup in the rows
		me,
	});
}
