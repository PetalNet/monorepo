#!/usr/bin/env node
// Writes Codex's rate-limit usage to the shared feed the Astrolabe dashboard reads
// (`CODEX_USAGE_PATH`). Cron runs it every 5 minutes from a release checkout of main:
//     */5 * * * * <release>/apps/astrolabe/feed/codex-usage-snapshot.ts
import { writeFileSync } from "node:fs";

import { snapshot } from "./codex-usage.ts";

const out = process.env.CODEX_USAGE_OUT ?? "/home/docker/.claude/shared/codex-usage.json";

// Astrolabe bind-mounts this one file read-only, so it is overwritten in place: a file renamed over
// it would leave the container reading the old inode. A reader that catches it mid-write shows the
// feed as stale until its next request. A failed read throws before this, and the file is kept.
writeFileSync(out, JSON.stringify(await snapshot()));
console.log(`[codex-usage-snapshot] wrote ${out}`);
