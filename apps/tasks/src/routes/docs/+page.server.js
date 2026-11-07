import { allDocsPage, allDocsCount } from "$lib/server/db.js";

// Bounded page (task-317): the old loader had NO limit and shipped the whole accumulating doc
// corpus every visit. Now one SQL page (?page=N, 0-based); the project grouping runs over just
// that page, so a group may continue onto the next page (the pager states the range + total).
const PAGE = 60;

export function load({ url, locals }) {
	const me = locals.user;
	const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
	const total = allDocsCount(me);
	const docs = allDocsPage(me, PAGE, page * PAGE);
	// group by project, preserving the (project-name, updated desc) order from the query
	const groups = [];
	const idx = new Map();

	for (const d of docs) {
		const key = d.project_name || "(no project)";
		let g = idx.get(key);

		if (!g) {
			g = { project: key, project_id: d.project_id, docs: [] };
			idx.set(key, g);
			groups.push(g);
		}

		g.docs.push(d);
	}

	return {
		groups,
		total,
		shown: docs.length,
		page,
		pageSize: PAGE,
		hasMore: (page + 1) * PAGE < total,
	};
}
