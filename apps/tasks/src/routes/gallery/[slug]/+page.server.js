import { error } from "@sveltejs/kit";

import { galleryHref, projectKey, workOf } from "#lib/gallery-tree.js";
import { getArtifact, getMarkup } from "#lib/server/db.js";
import { renderMd } from "#lib/server/md.js";

// One artifact reader. getArtifact enforces the same visibility gate as the rest of
// tasks (private = owner-only) IN SQL, returning undefined for unknown OR forbidden
// slugs — so an outsider gets a uniform 404 that never reveals a private artifact's
// existence. Markdown is rendered server-side through the shared renderMd (which drops
// raw HTML at the parse boundary, then runs rehype-sanitize) so there is no stored-XSS
// path. HTML artifacts are NOT inlined — the page embeds them in a locked-down sandbox
// iframe that pulls /gallery/[slug]/raw (see that route + the iframe sandbox attr).
export function load({ params, locals }) {
	const a = getArtifact(params.slug, locals.user);

	if (!a) {
		throw error(404, "No such artifact");
	}

	const links = JSON.parse(a.links);
	const project = projectKey(a.collection);
	const work = workOf(links)?.label;

	return {
		// the ancestors of this artifact, nearest the root first; the page itself is the title
		crumbs: [
			{ label: a.collection || "unfiled", href: galleryHref({ project }) },
			...(work ? [{ label: work, href: galleryHref({ project, work }) }] : []),
		],
		slug: a.slug,
		title: a.title,
		description: a.description,
		kind: a.kind,
		source: a.source,
		rev: a.rev,
		links,
		// the page may ask this viewer something: it has the feedback capability and they are in its audience
		canAnswer:
			JSON.parse(a.caps).includes("feedback") && JSON.parse(a.audience).includes(locals.user),
		updated_at: a.updated_at,
		// only markdown artifacts are rendered here; html ones load via the sandboxed iframe
		bodyHtml: a.kind === "markdown" ? renderMd(a.content) : "",
		me: locals.user,
		// the viewer's saved pencil ink (page artifacts only; see /api/markup/[slug])
		markup:
			a.kind !== "markdown" && locals.user ? (getMarkup(a.slug, locals.user)?.strokes ?? []) : [],
	};
}
