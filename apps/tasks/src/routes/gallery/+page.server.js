import { Effect } from "effect";

import { galleryHref, inScope, projectKey, workOf } from "#lib/gallery-tree.js";
import { findArtifactsByLink, listArtifacts, needsYou } from "#lib/server/db.js";
import { galleryApi } from "#lib/server/gallery/api.ts";
import { viewerInterest } from "#lib/server/gallery/interest.ts";
import { ongoingOf } from "#lib/server/gallery/ongoing.ts";

// Gallery index: metadata only (title, date, description, links), visibility-gated to the
// signed-in user. Content blobs are never loaded here; they're fetched per-page.
// Every view state is in the query string, so a link reproduces what the sender saw:
//   ?project=<collection | _>   one project        ?work=<owner/repo#12>   one piece of work in it
//   ?link=<PR, issue, commit or repo>   only pages that link there ("owner/repo#12" works)
//   ?view=ongoing   everything in motion in that scope, instead of its pages
//   ?show=all   every project; without it and without a project, the viewer's own projects
export async function load(event) {
	const { locals, url } = event;

	// following or hiding a project, and opening one, change what is the viewer's
	event.depends("gallery:tree");

	const link = url.searchParams.get("link")?.trim() ?? "";
	const project = url.searchParams.get("project") ?? "";
	const work = url.searchParams.get("work") ?? "";
	// a search finds pages, so it has no ongoing view
	const view = !link && url.searchParams.get("view") === "ongoing" ? "ongoing" : "";
	const found = link ? new Set(findArtifactsByLink(link, locals.user).map((a) => a.slug)) : null;
	const all = listArtifacts(locals.user)
		.filter((a) => !found || found.has(a.slug))
		.map((a) => ({ ...a, links: JSON.parse(a.links) }));
	const show = url.searchParams.get("show") === "all" ? "all" : undefined;
	const { interest, inMotion } = await galleryApi.run(
		Effect.gen(function* () {
			const seen = yield* viewerInterest;

			return { interest: seen.interest, inMotion: yield* ongoingOf(seen, { project, work, show }) };
		}),
		event,
	);
	// Without a project or a search the index is the viewer's own projects; ?show=all lifts that.
	const own = !project && !link && !show;
	const asked = new Set(needsYou(locals.user).map((a) => a.slug));
	// a page that asks the viewer something is shown wherever it is filed
	const artifacts = inScope(all, { project, work }).filter(
		(a) => !own || interest.mine.has(projectKey(a.collection)) || asked.has(a.slug),
	);
	const projects = new Set(all.map((a) => projectKey(a.collection)));
	const scope = artifacts.map((a) => ({
		...a,
		links: a.links.filter((l) => l.label !== work),
		work: workOf(a.links)?.label ?? "",
		asked: asked.has(a.slug),
	}));

	return {
		view,
		// a search finds pages, so it has no ongoing list
		ongoing: link ? undefined : inMotion,
		artifacts: scope,
		link,
		project,
		// the project this page counts as opening
		opened: project,
		work,
		show,
		own,
		// nothing involves the viewer yet and they follow nothing: the index offers every project to follow
		pick:
			own && !interest.focused
				? [...Map.groupBy(all, (a) => projectKey(a.collection))].map(([key, pages]) => ({
						key,
						count: pages.length,
						choice: interest.choices.get(key),
					}))
				: undefined,
		// how many projects the viewer's own view leaves out
		others: own ? projects.size - interest.mine.size : 0,
		choice: interest.choices.get(project),
		workUrl: work ? workOf(artifacts[0]?.links ?? [])?.url : undefined,
		me: locals.user,
		crumbs: [
			...(view && !project
				? [
						{
							label: own ? "Your projects" : "All projects",
							href: galleryHref({ show }),
						},
					]
				: []),
			...(project && (work || view)
				? [{ label: project === "_" ? "unfiled" : project, href: galleryHref({ project }) }]
				: []),
			...(work && view ? [{ label: work, href: galleryHref({ project, work }) }] : []),
		],
	};
}
