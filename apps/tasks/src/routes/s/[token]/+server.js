import { getArtifactByShareToken } from "$lib/server/db.js";
import { renderMd } from "$lib/server/md.js";
import { error } from "@sveltejs/kit";

// PUBLIC, SSO-EXEMPT scoped share view: /s/<token>.
//
// This is the ONE route Traefik exempts from the Authentik forward-auth middleware (see
// /srv/traefik/dynamic/tasks.yml — router `tasks-share`, PathPrefix `/s/`, NO authentik
// mw, high priority). Everything else on tasks.example.com stays gated. Because there is no SSO
// in front of this handler, ALL of the access control lives right here, and it is FAIL-CLOSED.
//
// SECURITY CONTRACT (the whole point of the feature):
//  - Resolution: hash the RAW token (sha256) and look up a share row that is revoked=0 AND not
//    expired, IN SQL (getArtifactByShareToken). The raw token is never stored; only its hash is.
//    Any miss — unknown / revoked / expired / malformed token, or a deleted artifact — yields
//    undefined → a single generic 404. We never distinguish those cases (no existence/expiry leak).
//  - Scoped to ONE artifact: the token row names exactly one slug; nothing in the URL or params
//    lets a visitor reach a different artifact, a listing, the gallery, an API, or any task. The
//    only param is [token]; the slug is derived server-side from the matched share row.
//  - Read-only: GET only. No actions, no mutation path, no form. (A non-GET method 405s by SvelteKit.)
//  - Rendering reuses the gallery raw view EXACTLY:
//      * interactive → sandbox allow-scripts (opaque origin, no allow-same-origin) — its JS can't
//        read any cookie (there is none here anyway), reach a parent (it's the top doc), or make
//        scripted background requests (default-src 'none'). Same cage as /gallery/[slug]/raw.
//      * html        → sandbox WITHOUT allow-scripts (zero JS) — but NOTE we do NOT grant
//        allow-same-origin on the public route (the gallery grants it only so the PARENT iframe can
//        measure scrollHeight to auto-size; here the artifact is the top document, so there is no
//        parent and no reason to weaken the origin). Static, contained.
//      * markdown    → rendered server-side through the shared sanitizing renderMd (drops raw HTML
//        at the parse boundary, then rehype-sanitize) into a minimal self-contained page. No app
//        chrome, no nav, no links back into the gated tracker.
//  - noindex: X-Robots-Tag header + (for markdown) a <meta name="robots" content="noindex"> so a
//    leaked secret link never lands in a search index.
//  - No-store/no-referrer: a shared cache must not reuse it; the token must not leak via Referer.
//
// CSP profiles mirror /gallery/[slug]/raw, MINUS allow-same-origin for html (see above).
const CSP = {
	html: "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'",
	interactive:
		"sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'none'",
};

// Shared hardening headers for every served response (and the 404 path stays generic).
const HARDEN = {
	"x-robots-tag": "noindex, nofollow",
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "private, no-store",
	"permissions-policy":
		"camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=(), usb=(), serial=(), hid=()",
};

// Minimal HTML escaper for the markdown wrapper's <title>.
const esc = (s) =>
	String(s || "").replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	);

export function GET({ params }) {
	const a = getArtifactByShareToken(params.token);
	// FAIL CLOSED — any miss is an indistinguishable generic 404 (no info leak about why).
	if (!a) throw error(404, "Not found");

	if (a.kind === "interactive" || a.kind === "html") {
		const csp = CSP[a.kind];
		return new Response(a.content, {
			headers: {
				...HARDEN,
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": csp,
			},
		});
	}

	if (a.kind === "markdown") {
		const bodyHtml = renderMd(a.content); // sanitized server-side render
		// Self-contained page: noindex meta + a tight inline CSP. No nav, no app chrome, no link back
		// into the gated tracker. style-src unsafe-inline for the small inline stylesheet only.
		const page = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(a.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; line-height: 1.65;
         font: 16px/1.65 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #16181c; } a { color: #8ab4f8; } }
  h1, h2, h3 { line-height: 1.25; }
  pre { overflow-x: auto; padding: 12px; background: rgba(127,127,127,.12); border-radius: 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,.4); padding: 6px 10px; }
</style>
</head><body>
<h1>${esc(a.title)}</h1>
${bodyHtml}
</body></html>`;
		return new Response(page, {
			headers: {
				...HARDEN,
				"content-type": "text/html; charset=utf-8",
				// inline-style-only page; no scripts, no remote anything.
				"content-security-policy":
					"default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'",
			},
		});
	}

	// Unknown kind → generic 404 (fail closed).
	throw error(404, "Not found");
}
