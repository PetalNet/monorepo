import { projectName } from "$lib/people.js";
import { searchTasks, listProjects } from "$lib/server/db.js";

// Global search results for the top-bar box. Read-only; searchTasks is already
// visibility-gated (private items you don't own never match). Columns are scrub-safe
// (no claim_token / lease), so nothing sensitive ships to the client.
export function load({ url, locals }) {
	const me = locals.user;
	const q = (url.searchParams.get("q") || "").trim();
	const projects = listProjects(me);
	const nameOf = projectName(projects);
	const results = q ? searchTasks(q, me).map((t) => ({ ...t, project: nameOf(t.project_id) })) : [];
	return { me, q, results };
}
