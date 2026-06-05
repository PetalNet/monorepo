// Identity + access gate. Behind Authentik forward-auth, traefik injects X-authentik-username.
// ALLOW (Authentik usernames) is the access list. With ALLOW set (production) we FAIL CLOSED:
// a missing/unknown header is rejected, never silently treated as the 'dev' identity. The
// 'dev' fallback exists ONLY for local dev where no ALLOW is configured.
const ALLOW = (process.env.ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);

export async function handle({ event, resolve }) {
  const user = event.request.headers.get('x-authentik-username') || '';
  if (ALLOW.length) {
    // production: require a valid Authentik identity (fail closed — was fail-open via 'dev')
    if (!user || !ALLOW.includes(user)) {
      return new Response('Private tracker — ask Alice for access.', {
        status: 403,
        headers: { 'content-type': 'text/plain' }
      });
    }
    event.locals.user = user;
  } else {
    // local dev only (no access list): permit the dev fallback identity
    event.locals.user = user || 'dev';
  }
  return resolve(event);
}
