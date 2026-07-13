// System-outbox source (N1b-3, PHASE1B-DESIGN §3 — the /task/681 driving use case). The lab's
// service bots (shawn/derek/michael) drop warnings as JSON files; today they flood Matrix. This
// tailer turns each into a typed `bot.message` bus signal so the console consumes them and Matrix
// goes quiet — "you go look, not get pinged". The body is kept verbatim (truncated); severity is
// read from the `[warn]`/`[fail]`/`[recovered]`/`[info]` prefix.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Emission } from "../emission.ts";
import { uuidv5 } from "./uuid5.ts";

interface OutboxFile {
	sender?: string;
	body?: string;
}

function severityOf(body: string): Emission["severity"] {
	const m = /^\s*\[(\w+)\]/.exec(body);
	const tag = (m?.[1] ?? "").toLowerCase();
	if (tag === "fail" || tag === "error" || tag === "critical") return "danger";
	if (tag === "warn" || tag === "warning") return "warn";
	return "info"; // info / recovered / unknown
}

/**
 * List new files (name > cursor) under `<dir>/sent`, parse each into a `bot.message` emission with
 * a deterministic id. Returns the emissions and the new cursor (the max filename seen). Throws if
 * the directory cannot be read (the caller turns that into `bridge.source.unreachable`).
 */
export function tailSystemOutbox(
	dir: string,
	cursor: string,
	ts: string,
): { emissions: Emission[]; cursor: string } {
	const sentDir = join(dir, "sent");
	const names = readdirSync(sentDir)
		.filter((n) => n.endsWith(".json") && n > cursor)
		.sort();
	const emissions: Emission[] = [];
	let newCursor = cursor;
	for (const name of names) {
		newCursor = name;
		let parsed: OutboxFile;
		try {
			parsed = JSON.parse(readFileSync(join(sentDir, name), "utf8")) as OutboxFile;
		} catch {
			continue; // skip an unreadable/partial file; a later poll re-reads if it's rewritten
		}
		const sender = (parsed.sender ?? "unknown").toLowerCase();
		const body = (parsed.body ?? "").slice(0, 500);
		emissions.push({
			schema_version: 1,
			id: uuidv5(`system-outbox:${name}`),
			type: "bot.message",
			ts,
			source: { service: "bridge", host: ".14", agent: null },
			subject: sender,
			subject_kind: "service",
			severity: severityOf(body),
			action: null,
			scope: "fleet",
			dimensions: { sender, message: body, file: name },
		});
	}
	return { emissions, cursor: newCursor };
}
