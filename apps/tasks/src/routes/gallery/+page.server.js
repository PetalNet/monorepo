import { galleryHref, inScope, projectKey, workOf } from "#lib/gallery-tree.js";
import { findArtifactsByLink, listArtifacts, needsYou } from "#lib/server/db.js";
import { galleryApi } from "#lib/server/gallery/api.ts";
import { ongoing } from "#lib/server/gallery/ongoing.ts";

// Gallery index: metadata only (title, date, description, links), visibility-gated to the
// signed-in user. Content blobs are never loaded here; they're fetched per-page.
// Every view state is in the query string, so a link reproduces what the sender saw:
//   ?project=<collection | _>   one project        ?work=<owner/repo#12>   one piece of work in it
//   ?link=<PR, issue, commit or repo>   only pages that link there ("owner/repo#12" works)
//   ?view=ongoing   everything in motion in that scope, instead of its pages
//   ?show=all   every project; without it and without a project, the viewer's own projects
export async function load(event) {
	const { locals, url } = event;
	const link = url.searchParams.get("link")?.trim() ?? "";
	const project = url.searchParams.get("project") ?? "";
	const work = url.searchParams.get("work") ?? "";
	// a search finds pages, so it has no ongoing view
	const view = !link && url.searchParams.get("view") === "ongoing" ? "ongoing" : "";
	const found = link ? new Set(findArtifactsByLink(link, locals.user).map((a) => a.slug)) : null;
	const all = listArtifacts(locals.user)
		.filter((a) => !found || found.has(a.slug))
		.map((a) => ({ ...a, links: JSON.parse(a.links) }));
	const { tree, focused } = await event.parent();
	const show = url.searchParams.get("show") === "all" ? "all" : undefined;
	// Without a project or a search the index is the viewer's own projects; ?show=all lifts that.
	const own = !project && !link && !show && focused;
	const mine = new Set(tree.filter((p) => p.mine).map((p) => p.key));
	const asked = new Set(needsYou(locals.user).map((a) => a.slug));
	// a page that asks the viewer something is shown wherever it is filed
	const artifacts = inScope(all, { project, work }).filter(
		(a) => !own || mine.has(projectKey(a.collection)) || asked.has(a.slug),
	);
	const scope = artifacts.map((a) => ({
		...a,
		links: a.links.filter((l) => l.label !== work),
		work: workOf(a.links)?.label ?? "",
		asked: asked.has(a.slug),
	}));

	return {
		view,
		// a search finds pages, so it has no ongoing list
		ongoing: link ? undefined : await galleryApi.run(ongoing({ project, work, show }), event),
		artifacts: scope,
		link,
		project,
		// the project this page counts as opening
		opened: project,
		work,
		show,
		own,
		// how many projects the viewer's own view leaves out
		others: own ? tree.length - mine.size : 0,
		choice: tree.find((p) => p.key === project)?.choice,
		workUrl: work ? workOf(artifacts[0]?.links ?? [])?.url : undefined,
		me: locals.user,
		crumbs: [
			...(view && !project
				? [{ label: own ? "Your projects" : "All projects", href: galleryHref({ show }) }]
				: []),
			...(project && (work || view)
				? [{ label: project === "_" ? "unfiled" : project, href: galleryHref({ project }) }]
				: []),
			...(work && view ? [{ label: work, href: galleryHref({ project, work }) }] : []),
		],
	};
}
