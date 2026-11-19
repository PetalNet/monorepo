// Entry point of the wake-filter UserPromptSubmit hook; the rules and why they exist are in
// wake-filter-classify.ts. Prints a block decision when every item in the prompt matches a rule, logs the drop,
// and lets anything else through.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classify, type Drop } from "./wake-filter-classify.ts";

const log =
	process.env["WAKE_FILTER_LOG"] ?? path.join(os.homedir(), ".claude/state/wake-filter.jsonl");

// The last 64 KiB of the drop log: the disk rule asks what was dropped lately.
function recentDrops(): Drop[] {
	let fd: number | undefined;

	try {
		fd = fs.openSync(log, "r");
		const size = fs.fstatSync(fd).size;
		const buf = Buffer.alloc(Math.min(size, 65536));

		fs.readSync(fd, buf, 0, buf.length, size - buf.length);

		return buf
			.toString("utf8")
			.split("\n")
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as Drop];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	} finally {
		if (fd !== undefined) {
			fs.closeSync(fd);
		}
	}
}

function main() {
	let drops;

	try {
		const input = JSON.parse(fs.readFileSync(0, "utf8")) as { prompt?: unknown } | null;

		drops = classify(input?.prompt, { history: recentDrops(), now: Date.now() });
	} catch {
		return;
	}

	if (!drops) {
		return;
	}

	const ts = new Date().toISOString();

	try {
		fs.appendFileSync(log, drops.map((d) => `${JSON.stringify({ ts, ...d })}\n`).join(""));
	} catch {
		// Dropping without a record would hide the drop, so let the prompt through.
		return;
	}

	process.stdout.write(
		JSON.stringify({
			decision: "block",
			reason: `wake-filter: dropped ${drops.map((d) => d.rule).join(", ")} (logged in ${log})`,
		}),
	);
}

main();
