// Identity + access gate. Behind Authentik forward-auth, traefik injects X-authentik-username.
// ALLOW (Authentik usernames) is the access list; anyone else authenticated gets a private page.
// No header (local dev) = "dev", always allowed.
const ALLOW = (process.env.ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);

export async function handle({ event, resolve }) {
  const user = event.request.headers.get('x-authentik-username') || '';
  event.locals.user = user || 'dev';
  if (ALLOW.length && user && !ALLOW.includes(user)) {
    return new Response('Private tracker — ask Alice for access.', {
      status: 403,
      headers: { 'content-type': 'text/plain' }
    });
  }
  return resolve(event);
}
