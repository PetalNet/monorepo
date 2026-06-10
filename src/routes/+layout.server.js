import { activeLeases } from '$lib/server/db.js';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Live agent-fleet heartbeat (written by the warm session / future manager into the
// DB data dir — the only path the container mounts). Best-effort: null if absent/bad.
// Cached and re-read only when the file's mtime changes — avoids a readFileSync +
// JSON.parse on every single navigation.
let fleetCache = { mtime: -1, value: null };
function readFleet() {
  try {
    const path = join(dirname(process.env.TASKS_DB_PATH || 'tasks.db'), 'agent-fleet-status.json');
    const mtime = statSync(path).mtimeMs;
    if (mtime !== fleetCache.mtime) {
      fleetCache = { mtime, value: JSON.parse(readFileSync(path, 'utf8')) };
    }
    return fleetCache.value;
  } catch {
    fleetCache = { mtime: -1, value: null };
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
  return { activeAgents: byAgent, fleet: readFleet(), user: locals.user };
}
