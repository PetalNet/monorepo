// SessionStart hook (Own-the-Outcome §7): surface the open-objectives ledger at every session start, including
// --resume after a restart, so owned work is never silently orphaned. It injects a short index (one line per titled
// objective with its state and next step) instead of the whole ledger: hook context over 10,000 characters is
// replaced by a file path and a 2,000-character preview (code.claude.com/docs/en/hooks), and the ledger is ~220 KB.
// Fails open on any error: a session start is never blocked.
import { readdirSync, readFileSync, statSync } from "node:fs";

import { index, parse } from "./objectives-index-ledger.ts";

// An empty variable counts as unset.
function envOr(name: string, fallback: string) {
	const v = process.env[name];

	return v === undefined || v === "" ? fallback : v;
}

const LEDGER = envOr(
	"OBJECTIVES_LEDGER",
	`${process.env["HOME"] ?? ""}/.claude/shared/open-objectives.md`,
);
let out = "";

try {
	const led = readFileSync(LEDGER, "utf8");

	if (led.trim()) {
		out += index(parse(led), { path: LEDGER });
	}
} catch {
	/* fail open */
}

// Background-agent output files from the last day: possible unhandled worker results across a restart. Older ones
// (thousands accumulate) are not worth a line each.
const ROOTS = envOr("TASK_OUTPUT_ROOTS", "")
	.split(":")
	.filter((r) => r !== "");
const hits: [number, string][] = [];

for (const root of ROOTS) {
	try {
		for (const d of readdirSync(root, { withFileTypes: true })) {
			if (!d.isDirectory()) {
				continue;
			}

			try {
				for (const f of readdirSync(`${root}/${d.name}/tasks`)) {
					if (!f.endsWith(".output")) {
						continue;
					}

					const p = `${root}/${d.name}/tasks/${f}`;
					const m = statSync(p).mtimeMs;

					if (Date.now() - m < 86400000) {
						hits.push([m, p]);
					}
				}
			} catch {
				/* no tasks dir */
			}
		}
	} catch {
		/* no such root */
	}
}

if (hits.length > 0) {
	const newest = hits
		.toSorted((a, b) => b[0] - a[0])
		.slice(0, 5)
		.map((h) => h[1])
		.join(", ");

	out += `\n${String(hits.length)} background-agent output file(s) changed in the last 24 h (check whether a completed worker result is unhandled before assuming it landed). Newest: ${newest}\n`;
}

if (out) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: out },
		}),
	);
}
