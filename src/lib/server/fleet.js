// Live agent-fleet consumer.
//
// Source of truth: per-agent status files written by the Claude Code lifecycle
// hooks into `<dataDir>/fleet/<handle>.json`. Each file is the agent's CURRENT
// status, overwritten on every SessionStart / PreToolUse / PostToolUse / Stop
// event:
//   { handle, host, status: alive|working|idle, current_tool, started_at,
//     updated_at (ISO), session_id }
//
// This module reads ALL fleet/*.json, decides each agent's live status from its
// freshness, joins its focus task (the task it currently has claimed, status=doing
// AND assignee=handle), and returns a clean sorted fleet array for the cockpit +
// the sidebar rail. The old single agent-fleet-status.json is no longer used here.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeLeases } from './db.js';

// Mirror db.js's path resolution so the fleet dir sits next to tasks.db (the only
// mounted path in the container: /data → /data/fleet).
const DEFAULT_DB_PATH = resolve(fileURLToPath(import.meta.url), '../../../../data/tasks.db');
const FLEET_DIR = join(dirname(process.env.TASKS_DB_PATH || DEFAULT_DB_PATH), 'fleet');

// An agent that hasn't written its file in this long is treated as offline/stale —
// the hooks fire on every tool call, so a healthy working agent updates every few
// seconds; >90s of silence means it isn't reporting.
export const STALE_MS = 90_000;

// canonical statuses we render dots for
const KNOWN_STATUS = new Set(['working', 'alive', 'idle']);

// Canonical agent roster — the known fleet. Agents that aren't currently writing a
// fleet/<handle>.json heartbeat still appear (greyed, offline) so the cockpit shows the
// WHOLE fleet, not just whoever happens to be reporting (Bob: "the rest of them exist").
// A live file always wins over its roster stub; a live agent NOT in this list still shows
// (forward-compatible). Override the default list with TASKS_FLEET_ROSTER (CSV of
// `handle:host`) — no code change needed.
const ROSTER = (() => {
  const env = (process.env.TASKS_FLEET_ROSTER || '').trim();
  const base = env
    ? env.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
        const [handle, host] = pair.split(':');
        return { handle: handle.toLowerCase(), host: host || null };
      })
    : [
        { handle: 'agent-a', host: '.14' },
        { handle: 'agent-b', host: 'example-host' },
        { handle: 'agent-c', host: 'example-host' },
        { handle: 'codex', host: '.14' },
        { handle: 'agent-d', host: '.14' },
        { handle: 'agent-e', host: '.14' }
      ];
  return base;
})();

// status → sort weight (working first, then alive/idle, then offline last)
const RANK = { working: 0, alive: 1, idle: 2, offline: 3 };

// Normalize a host label to ONE canonical form. The live lifecycle hooks report
// agent-a's host as "dot14", while the roster + UI use ".14" — unify on ".14" so the
// same machine never renders two ways (Bob: "both @dot14 and @.14"). Any "dotN" → ".N".
function normHost(h) {
  if (!h) return null;
  const s = String(h).trim();
  if (!s) return null;
  const m = /^dot(\d+)$/i.exec(s);
  return m ? `.${m[1]}` : s;
}

function ageMs(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity;
}

// Read + parse every fleet/*.json. Best-effort per file: a malformed or
// mid-write file is skipped, never throws.
function readFleetFiles() {
  let names;
  try {
    names = readdirSync(FLEET_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return []; // dir absent (e.g. before the hook ever runs) → empty fleet
  }
  const out = [];
  for (const n of names) {
    try {
      const raw = JSON.parse(readFileSync(join(FLEET_DIR, n), 'utf8'));
      if (raw && typeof raw === 'object') {
        // trust the filename as the canonical handle if the body omits it
        raw.handle = String(raw.handle || n.replace(/\.json$/, '')).toLowerCase();
        out.push(raw);
      }
    } catch {
      /* skip unreadable / half-written file */
    }
  }
  return out;
}

/**
 * Build the live fleet view.
 * @param {string|undefined} me  the signed-in Authentik user (for task visibility)
 * @returns {{ agents: Array, totals: {agents:number, online:number, working:number, offline:number} }}
 */
export function getFleet(me) {
  // Focus map: handle → [{id,title}] of tasks it currently has claimed (doing).
  const focusByAgent = {};
  for (const t of activeLeases(me)) {
    const h = String(t.assignee).toLowerCase();
    (focusByAgent[h] ??= []).push({ id: t.id, title: t.title });
  }

  const agents = readFleetFiles().map((f) => {
    const age = ageMs(f.updated_at);
    const stale = age >= STALE_MS;
    // stale → the agent isn't reporting → offline regardless of last-written status.
    const reported = KNOWN_STATUS.has(f.status) ? f.status : 'idle';
    const status = stale ? 'offline' : reported;
    const focus = focusByAgent[f.handle] ?? [];
    return {
      handle: f.handle,
      host: normHost(f.host),
      status,
      reported, // last status it actually wrote (for the offline tooltip)
      offline: stale,
      current_tool: status === 'working' ? f.current_tool || null : null,
      updated_at: f.updated_at || null,
      age_ms: Number.isFinite(age) ? age : null,
      session_id: f.session_id || null,
      focus, // [{id,title}] — the claimed task(s); focus[0] is the headline
      started_at: f.started_at || null
    };
  });

  // Fold in roster members that aren't currently reporting → greyed offline stubs, so the
  // cockpit shows the whole known fleet, not just whoever wrote a file (Bob). Live files win.
  const present = new Set(agents.map((a) => a.handle));
  for (const r of ROSTER) {
    if (present.has(r.handle)) continue;
    agents.push({
      handle: r.handle,
      host: normHost(r.host),
      status: 'offline',
      reported: null,
      offline: true,
      current_tool: null,
      updated_at: null,
      age_ms: null,
      session_id: null,
      focus: focusByAgent[r.handle] ?? [],
      started_at: null,
      never_seen: true // roster stub: this agent has never written a heartbeat
    });
  }

  agents.sort((a, b) => {
    const r = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
    if (r) return r;
    // within a bucket: most-recently-updated first
    return (a.age_ms ?? Infinity) - (b.age_ms ?? Infinity);
  });

  const totals = {
    agents: agents.length,
    online: agents.filter((a) => !a.offline).length,
    working: agents.filter((a) => a.status === 'working').length,
    offline: agents.filter((a) => a.offline).length
  };

  return { agents, totals };
}
