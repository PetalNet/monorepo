import { getArtifact, listShareDraftsForSlug } from "$lib/server/db.js";
import { renderMd } from "$lib/server/md.js";
import { error } from "@sveltejs/kit";

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

	return {
		slug: a.slug,
		title: a.title,
		description: a.description,
		kind: a.kind,
		source: a.source,
		updated_at: a.updated_at,
		// only markdown artifacts are rendered here; html ones load via the sandboxed iframe
		bodyHtml: a.kind === "markdown" ? renderMd(a.content) : "",
		me: locals.user,
		// Drafts saved through draft-enabled share links (/s/<token>/draft). Sent as PLAIN TEXT
		// only: the page renders it in a <pre> with Svelte's default escaping, never {@html}
		// and never through markdown.
		drafts: listShareDraftsForSlug(a.slug).map(draftText),
	};
}

// A stored draft is JSON {paras:[...]} written by an anonymous visitor. Flatten it to plain text
// (a blank line between paragraphs). Anything unparseable shows as an empty draft, not an error.
function draftText(d) {
	let paras = [];

	try {
		const parsed = JSON.parse(d.content);

		if (Array.isArray(parsed.paras)) {
			paras = parsed.paras.filter((p) => typeof p === "string");
		}
	} catch {
		paras = [];
	}

	const text = paras.map((p) => p.trim()).join("\n\n");

	return {
		share_id: d.share_id,
		label: d.label || "",
		updated_at: d.created_at,
		revisions: d.revisions,
		text,
		words: text.trim() ? text.trim().split(/\s+/).length : 0,
	};
}
