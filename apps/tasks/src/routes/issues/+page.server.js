import { issuesList, listProjects, deepScrub } from "$lib/server/db.js";

export function load({ locals }) {
	const all = issuesList(locals.user);
	const closed = (i) => i.status === "done" || i.status === "dropped";

	return deepScrub({
		open: all.filter((i) => !closed(i)),
		closed: all.filter(closed),
		projectCount: new Set(all.map((i) => i.project_id).filter((x) => x != null)).size,
		projects: listProjects(locals.user),
	});
}
