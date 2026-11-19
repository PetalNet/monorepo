import { galleryHref, inScope, workOf } from "#lib/gallery-tree.js";
import { findArtifactsByLink, listArtifacts, needsYou } from "#lib/server/db.js";
import { galleryApi } from "#lib/server/gallery/api.ts";
import { ongoing } from "#lib/server/gallery/ongoing.ts";

// Gallery index: metadata only (title, date, description, links), visibility-gated to the
// signed-in user. Content blobs are never loaded here; they're fetched per-page.
// Every view state is in the query string, so a link reproduces what the sender saw:
//   ?project=<collection | _>   one project        ?work=<owner/repo#12>   one piece of work in it
//   ?link=<PR, issue, commit or repo>   only pages that link there ("owner/repo#12" works)
//   ?view=ongoing   everything in motion in that scope, instead of its pages
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
	const artifacts = inScope(all, { project, work });
	const asked = new Set(needsYou(locals.user).map((a) => a.slug));
	const scope = artifacts.map((a) => ({
		...a,
		links: a.links.filter((l) => l.label !== work),
		work: workOf(a.links)?.label ?? "",
		asked: asked.has(a.slug),
	}));

	return {
		view,
		// a search finds pages, so it has no ongoing list
		ongoing: link ? undefined : await galleryApi.run(ongoing({ project, work }), event),
		artifacts: scope,
		link,
		project,
		work,
		workUrl: work ? workOf(artifacts[0]?.links ?? [])?.url : undefined,
		me: locals.user,
		crumbs: [
			...(view && !project ? [{ label: "All projects", href: galleryHref() }] : []),
			...(project && (work || view)
				? [{ label: project === "_" ? "unfiled" : project, href: galleryHref({ project }) }]
				: []),
			...(work && view ? [{ label: work, href: galleryHref({ project, work }) }] : []),
		],
	};
}
