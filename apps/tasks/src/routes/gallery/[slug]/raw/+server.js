import { getArtifact } from "$lib/server/db.js";
import { error } from "@sveltejs/kit";

// Serves a standalone HTML artifact as its own document, for embedding in the
// sandboxed <iframe> on the reader page (and for the "open full" link).
//
// SECURITY:
//  - Auth: this route sits behind the global hooks.server gate like every route —
//    no Authentik identity in ALLOW => 403 before we run. We ALSO re-enforce the
//    per-artifact visibility gate here (getArtifact with locals.user) so a private
//    artifact 404s for anyone but its owner even via the raw endpoint.
//  - No path traversal: content comes from the DB by slug, never from a filesystem
//    path, so there's nothing to traverse. The [slug] param only ever hits a
//    parameterized SQL lookup.
//  - Containment: we send a Content-Security-Policy "sandbox" so even when opened
//    DIRECTLY (the "open full" link, not the iframe) the document is contained. Two
//    profiles, chosen by kind:
//      * 'html'        — NO allow-scripts (the doc runs zero JS) + allow-same-origin
//                        (so the parent can measure scrollHeight to auto-size the frame).
//                        Safe BECAUSE scripts are off: the cookie/DOM risk is the
//                        same-origin + scripts COMBO, which this profile never grants.
//      * 'interactive' — allow-scripts (live demos run) but NOT allow-same-origin, so the
//                        document is an OPAQUE origin. This is a CONFIDENTIALITY cage, not a
//                        full network jail: its JS CANNOT read the SSO cookie, reach the
//                        parent DOM, navigate the TOP frame (no allow-top-navigation), open
//                        popups (no allow-popups), or make any SCRIPTED background request —
//                        fetch/XHR/WebSocket/beacon, form submit (form-action), <a ping>,
//                        <img>/CSS url() (data:-only), and plugins are all blocked by
//                        default-src 'none'. RESIDUAL, and inherent to running scripts at
//                        all: a frame can navigate ITSELF to a remote URL (CSP doesn't gate
//                        document navigation), and WebRTC ICE isn't reliably caged — both can
//                        emit an outbound GET leaking the viewer's IP + whatever the script
//                        itself computed (NOT the cookie/parent — those stay sealed). There is
//                        no sandbox token or shipped CSP directive that closes self-navigation,
//                        so this is mitigated by the TRUST MODEL: artifacts are author-only
//                        (no user-upload path), i.e. as trusted as anything else we publish.
//                        If a user-upload path is ever added, move interactive artifacts to a
//                        separate cookieless origin before trusting this. allow-downloads lets
//                        a demo offer a local save (e.g. canvas → PNG).
//    Either way: NO scripted remote fetches; img/font data:-only; external <a href> citation
//    links still work ("open full" opens them in a normal new tab). A Permissions-Policy
//    (below) additionally denies camera/mic/geo/etc.
//  - We must override the global X-Frame-Options: DENY for THIS route only, or our
//    own same-origin iframe would be blocked. frame-ancestors 'self' (via CSP)
//    keeps it embeddable only by tasks itself.
const CSP = {
	html: "sandbox allow-same-origin; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'self'",
	// allow-scripts WITHOUT allow-same-origin == scripts run in an opaque origin (no cookie/parent
	// access). No connect/fetch (default-src 'none'). script/style inline for the docs' own blocks.
	interactive:
		"sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'",
};

export function GET({ params, locals }) {
	const a = getArtifact(params.slug, locals.user);

	if (!a) throw error(404, "No such artifact");

	const csp = CSP[a.kind];

	if (!csp) throw error(404, "Not a page artifact");

	return new Response(a.content, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": csp,
			"x-frame-options": "SAMEORIGIN",
			// Defense-in-depth over the (author-only) interactive JS: deny the device/identity
			// surfaces CSP doesn't gate. WebRTC ICE is the one network channel CSP can't reliably
			// cage cross-engine — the threat model here is "trusted-author content, sandbox is
			// belt-and-suspenders", so a leak needs malicious authored content; if a user-upload
			// path is ever added, close WebRTC explicitly before trusting this.
			"permissions-policy":
				"camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=(), usb=(), serial=(), hid=()",
			// private content behind SSO: don't let a shared cache (or post-logout browser) reuse it.
			"cache-control": "private, no-store",
			"referrer-policy": "no-referrer",
		},
	});
}
