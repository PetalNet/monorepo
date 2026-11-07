import { issuesPage, issuesCounts, listProjects, deepScrub } from "$lib/server/db.js";

// Bounded pages (task-317): the old loader shipped the ENTIRE open+closed history every visit and
// split it in JS. Now the open/closed split + comment counts + totals are SQL, and each tab loads
// one page. ?tab=open|closed selects the lane, ?page=N (0-based) the slice.
const PAGE = 50;

export function load({ url, locals }) {
	const me = locals.user;
	const tab = url.searchParams.get("tab") === "closed" ? "closed" : "open";
	const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
	const rows = issuesPage(me, tab, PAGE + 1, page * PAGE); // +1 sentinel = "is there a next page?"
	const hasMore = rows.length > PAGE;
	const counts = issuesCounts(me);

	return deepScrub({
		tab,
		page,
		hasMore,
		pageSize: PAGE,
		rows: hasMore ? rows.slice(0, PAGE) : rows,
		openCount: counts.open ?? 0,
		closedCount: counts.closed ?? 0,
		projectCount: counts.projects ?? 0,
		projects: listProjects(me),
	});
}
