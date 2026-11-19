import { galleryHref, inScope, workOf } from "#lib/gallery-tree.js";
import { findArtifactsByLink, listArtifacts, needsYou } from "#lib/server/db.js";

// Gallery index: metadata only (title, date, description, links), visibility-gated to the
// signed-in user. Content blobs are never loaded here; they're fetched per-page.
// Every view state is in the query string, so a link reproduces what the sender saw:
//   ?project=<collection | _>   one project        ?work=<owner/repo#12>   one piece of work in it
//   ?link=<PR, issue, commit or repo>   only pages that link there ("owner/repo#12" works)
export function load({ locals, url }) {
	const link = url.searchParams.get("link")?.trim() ?? "";
	const project = url.searchParams.get("project") ?? "";
	const work = url.searchParams.get("work") ?? "";
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
		artifacts: scope,
		link,
		project,
		work,
		workUrl: work ? workOf(artifacts[0]?.links ?? [])?.url : undefined,
		me: locals.user,
		crumbs:
			work && project
				? [{ label: project === "_" ? "unfiled" : project, href: galleryHref({ project }) }]
				: [],
	};
}
