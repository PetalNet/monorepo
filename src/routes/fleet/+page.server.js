import { getFleet, STALE_MS } from '$lib/server/fleet.js';
import { deepScrub } from '$lib/server/db.js';

// fleet-terminal write tier — keep in lockstep with TERM_ADMIN in server.js / docker-compose.
const ADMIN = (process.env.TERM_ADMIN || 'alice,bob').split(',').map((s) => s.trim()).filter(Boolean);

export function load({ locals }) {
  const fleet = getFleet(locals.user);
  return deepScrub({
    ...fleet,
    now: Date.now(),
    staleMs: STALE_MS,
    me: locals.user || null,
    isAdmin: ADMIN.includes(locals.user) // → FleetTerminal canWrite (Interact toggle)
  });
}
