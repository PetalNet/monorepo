import { findArtifactsByLink, listArtifacts } from "#lib/server/db.js";

// Gallery index: metadata only (title, date, description, kind, links) — visibility-gated to
// the signed-in user. Content blobs are never loaded here; they're fetched per-page.
// ?link=<PR, issue, commit or repo> narrows it to the pages that link there ("owner/repo#12" works).
export function load({ locals, url }) {
	const link = url.searchParams.get("link")?.trim() ?? "";
	const found = link ? new Set(findArtifactsByLink(link, locals.user).map((a) => a.slug)) : null;
	const artifacts = listArtifacts(locals.user)
		.filter((a) => !found || found.has(a.slug))
		.map((a) => ({ ...a, links: JSON.parse(a.links) }));

	return { artifacts, link, me: locals.user };
}
