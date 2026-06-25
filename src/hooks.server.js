// Identity + access gate. Behind Authentik forward-auth, traefik injects X-authentik-username.
// ALLOW (Authentik usernames) is the access list. With ALLOW set (production) we FAIL CLOSED:
// a missing/unknown header is rejected, never silently treated as the 'dev' identity. The
// 'dev' fallback exists ONLY for local dev where no ALLOW is configured.
const ALLOW = (process.env.ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);

// PUBLIC scoped-share exemption (/s/<token>, the #487 feature): /s/ is the ONE SSO-exempt path.
// Traefik already strips the Authentik forward-auth middleware for PathPrefix `/s/` (see
// /srv/traefik/dynamic/tasks.yml router `tasks-share`), so this gate must NOT re-reject a
// /s/ request for lacking an identity. The /s/ handler (src/routes/s/[token]/+server.js) is
// fail-closed, read-only, and token-scoped to a single artifact, so ALL access control lives there.
// Strict exact-prefix match — exactly `/s` or `/s/…`, nothing else can ride the exemption.
const isPublicShare = (pathname) => pathname === '/s' || pathname.startsWith('/s/');
export async function handle({ event, resolve }) {
  const user = event.request.headers.get('x-authentik-username') || '';
  if (ALLOW.length && !isPublicShare(event.url.pathname)) {
    // production: require a valid Authentik identity (fail closed — was fail-open via 'dev')
    if (!user || !ALLOW.includes(user)) {
      return new Response('Private tracker — ask Alice for access.', {
        status: 403,
        headers: { 'content-type': 'text/plain' }
      });
    }
    event.locals.user = user;
  } else if (!ALLOW.length) {
    // local dev only (no access list): permit the dev fallback identity
    event.locals.user = user || 'dev';
  }
  // production + /s/ public share: no identity required; event.locals.user intentionally left
  // unset — the share route resolves strictly by token, never by user.
  // Skin: paper-and-ink is now the DEFAULT skin (Bob: "finish flipping over to DS").
  // Tag <html class="skin-paper-ink"> so the skin CSS activates. Escape hatch:
  // TASKS_SKIN=none falls back to the old dark-zinc/amber look; any other value
  // selects that named skin.
  const raw = (process.env.TASKS_SKIN ?? 'paper-ink').trim();
  const skin = raw === 'none' ? '' : raw;
  const res = await resolve(
    event,
    skin
      ? { transformPageChunk: ({ html }) => html.replace('<html lang="en">', `<html lang="en" class="skin-${skin}">`) }
      : undefined
  );
  // defense-in-depth headers (sanitizer is the primary XSS line; these harden the rest).
  // Use the no-clobber form: a route may legitimately need to relax a header for itself
  // (e.g. the gallery raw-artifact endpoint frames its own same-origin sandbox iframe, so
  // it sets X-Frame-Options: SAMEORIGIN + a CSP sandbox). Only fill in defaults it left unset.
  if (!res.headers.has('X-Frame-Options')) res.headers.set('X-Frame-Options', 'DENY'); // clickjacking
  res.headers.set('X-Content-Type-Options', 'nosniff');
  if (!res.headers.has('Referrer-Policy')) res.headers.set('Referrer-Policy', 'same-origin');
  return res;
}
