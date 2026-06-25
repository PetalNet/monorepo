import { json } from '@sveltejs/kit';
import { getFleet } from '$lib/server/fleet.js';
import { deepScrub } from '$lib/server/db.js';

// GET /fleet/data -> { agents, totals, now }
// Polled by the cockpit every few seconds for a live view without a full reload.
// deepScrub honors per-user visibility on the joined focus task titles (#285).
export function GET({ locals }) {
  const fleet = getFleet(locals.user);
  return json(deepScrub({ ...fleet, now: Date.now() }), {
    headers: { 'cache-control': 'no-store' }
  });
}
