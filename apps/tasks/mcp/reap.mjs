#!/usr/bin/env node
// In-repo lease reaper for the */7 cron. Single source of truth with the tracker MCP and the
// SvelteKit app — everything mutates through src/lib/server/db.js. Replaces the old standalone
// /srv/tracker-mcp/reap.mjs, which opened its own connection and ran a divergent raw
// UPDATE (part of the two-write-paths drift fixed in task-284). reapLeases() also clears the
// expired lease_expires_at, which the old standalone copy did not.
process.env.TASKS_DB_PATH ||= "/srv/tasks/data/tasks.db";
const { reapLeases } = await import("../src/lib/server/db.js");
const n = reapLeases();

if (n) console.log(`[reap ${new Date().toISOString()}] freed ${n} stale lease(s)`);
