import { error } from '@sveltejs/kit';
import { getArtifact } from '$lib/server/db.js';

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
//  - Containment: we send Content-Security-Policy "sandbox" so even when opened
//    DIRECTLY (the "open full" link, not the iframe) the document runs with no
//    scripts / no same-origin — it can't read the SSO cookie, call the API, or
//    touch anything. The iframe additionally carries sandbox="" on the element.
//  - We must override the global X-Frame-Options: DENY for THIS route only, or our
//    own same-origin iframe would be blocked. frame-ancestors 'self' (via CSP)
//    keeps it embeddable only by tasks itself.
export function GET({ params, locals }) {
  const a = getArtifact(params.slug, locals.user);
  if (!a) throw error(404, 'No such artifact');
  if (a.kind !== 'html') throw error(404, 'Not a page artifact');

  return new Response(a.content, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Tight CSP: sandbox with allow-same-origin ONLY (NO allow-scripts → scripts still
      // can't run; default-src 'none' double-blocks them). allow-same-origin is here so the
      // gallery parent can read the doc's scrollHeight and auto-size the frame; safe without
      // allow-scripts (the cookie/DOM risk is the same-origin + scripts COMBO, never granted).
      // NO remote fetches — img/font data:-only so an artifact can't beacon out the viewer's
      // IP, even though these are our own (trusted) artifacts. style 'unsafe-inline' is for the
      // documents' own <style> blocks. external <a href> citation links still work (sandbox
      // blocks in-frame nav; "open full" opens them in a normal new tab).
      'content-security-policy': "sandbox allow-same-origin; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'self'",
      'x-frame-options': 'SAMEORIGIN',
      // private content behind SSO: don't let a shared cache (or post-logout browser) reuse it.
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer'
    }
  });
}
