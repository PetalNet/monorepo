import { activeLeases } from '$lib/server/db.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Live agent-fleet heartbeat (written by the warm session / future manager into the
// DB data dir — the only path the container mounts). Best-effort: null if absent/bad.
function readFleet() {
  try {
    const dir = dirname(process.env.TASKS_DB_PATH || 'tasks.db');
    return JSON.parse(readFileSync(join(dir, 'agent-fleet-status.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Feed the sidebar agent rail with real in-progress work (who's on what right now).
export function load({ locals }) {
  const byAgent = {};
  for (const t of activeLeases(locals.user)) {
    const h = String(t.assignee).toLowerCase();
    (byAgent[h] ??= []).push({ id: t.id, title: t.title });
  }
  return { activeAgents: byAgent, fleet: readFleet() };
}
