import { activeLeases } from '$lib/server/db.js';

// Feed the sidebar agent rail with real in-progress work (who's on what right now).
export function load({ locals }) {
  const byAgent = {};
  for (const t of activeLeases(locals.user)) {
    const h = String(t.assignee).toLowerCase();
    (byAgent[h] ??= []).push({ id: t.id, title: t.title });
  }
  return { activeAgents: byAgent };
}
