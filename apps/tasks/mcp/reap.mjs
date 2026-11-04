#!/usr/bin/env node
// In-repo lease reaper for the */7 cron. Single source of truth with the tracker MCP and the
// SvelteKit app — everything mutates through src/lib/server/db.js. reapLeases() also clears
// expired lease_expires_at.
const { reapLeases } = await import("../src/lib/server/db.js");
const n = reapLeases();

if (n) console.log(`[reap ${new Date().toISOString()}] freed ${n} stale lease(s)`);
