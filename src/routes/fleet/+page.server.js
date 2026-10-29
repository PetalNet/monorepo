import { getFleet, STALE_MS } from '$lib/server/fleet.js';
import { deepScrub } from '$lib/server/db.js';

export function load({ locals }) {
  const fleet = getFleet(locals.user);
  return deepScrub({
    ...fleet,
    now: Date.now(),
    staleMs: STALE_MS,
    me: locals.user || null
  });
}
