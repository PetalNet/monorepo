// Glitchtip wiring verification (task-651). Throws a deliberate unexpected error so the
// hooks.server.js handleError → Glitchtip path can be proven end-to-end after any deploy
// or SDK bump. Hard-disabled (404) unless the service env sets GLITCHTIP_DEBUG=1; even
// enabled it only throws — no data exposure. Sits behind the normal SSO gate in prod.
import { error } from '@sveltejs/kit';

export function GET() {
  if (process.env.GLITCHTIP_DEBUG !== '1') error(404, 'Not found');
  throw new Error('glitchtip verification error (deliberate, task-651)');
}
