// System-outbox source (N1b-3, PHASE1B-DESIGN §3 — the /task/681 driving use case). The lab's
// service bots (shawn/derek/michael) drop warnings as JSON files; today they flood Matrix. This
// tailer turns each into a typed `bot.message` bus signal so the console consumes them and Matrix
// goes quiet — "you go look, not get pinged". The body is kept verbatim (truncated); severity is
// read from the `[warn]`/`[fail]`/`[recovered]`/`[info]` prefix.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Emission } from "../emission.ts";
import { uuidv5 } from "./uuid5.ts";

interface OutboxFile {
	sender?: unknown;
	body?: unknown;
}

// A bot message is a small line. Anything bigger is either not ours or malicious; cap the read so a
// crafted huge file can't drive the poller out of memory.
const MAX_FILE_BYTES = 64 * 1024;

// The subject is the authz/scope-relevant identity, so it must be trustworthy. Anyone who can drop a
// file into the outbox controls `sender`, so `sender` can NOT be the subject (it would let a writer
// forge a `bot.message` attributed to any identity). The subject is the fixed, trustworthy source;
// the claimed sender rides along as a labelled dimension.
const SUBJECT = "system-outbox";

function severityOf(body: string): Emission["severity"] {
	const m = /^\s*\[(\w+)\]/.exec(body);
	const tag = (m?.[1] ?? "").toLowerCase();
	if (tag === "fail" || tag === "error" || tag === "critical") return "danger";
	if (tag === "warn" || tag === "warning") return "warn";
	return "info"; // info / recovered / unknown
}

export interface TailResult {
	readonly emissions: Emission[];
	/** New resume point: the max filename over the contiguous clean prefix processed this pass. */
	readonly cursor: string;
	/** Count of `.json` files at-or-below `cursor` — the append-only invariant guard (see below). */
	readonly belowCount: number;
	/** A file appeared at/below the cursor (non-monotonic insert); this pass rescanned to recover it. */
	readonly anomaly: boolean;
}

/**
 * Scan `<dir>/sent` and map each new bot file into a `bot.message` emission with a deterministic
 * id. Throws only if the directory itself cannot be read (the caller turns that into
 * `bridge.source.unreachable`); a single bad _file_ never sinks the whole source.
 *
 * Cursor semantics — a CONTIGUOUS high-watermark that only advances over the unbroken clean prefix:
 *
 * - A partial/unparseable file is a BARRIER (transient — a write caught mid-flight): stop there,
 *   leave the cursor before it, retry next poll. Advancing past it would skip it forever.
 * - A non-regular file (symlink/dir) or an oversize file is SKIPPED past (a stable condition — it
 *   will never become our data; a symlink could also smuggle in unrelated readable JSON).
 * - Wrong-typed fields are coerced with safe defaults, never thrown on (one malformed record must not
 *   mark the entire source dark).
 *
 * Late/non-monotonic filenames — the producer writes strictly increasing nanosecond names into an
 * append-only `sent/`, so the fast path only looks at names `> cursor`. But a misbehaving producer
 * could drop a name at/below the cursor, which the fast path would miss forever. Because `sent/` is
 * append-only, that shows up as MORE files at/below the cursor than we last recorded
 * (`belowCount`). When that happens we flag an anomaly and rescan every file this pass — the
 * deterministic id dedups everything already in the lake, so the only cost is a re-read.
 * At-least-once delivery throughout.
 */
export function tailSystemOutbox(
	dir: string,
	cursor: string,
	knownBelowCount: number,
	ts: string,
): TailResult {
	const sentDir = join(dir, "sent");
	const all = readdirSync(sentDir)
		.filter((n) => n.endsWith(".json"))
		.sort();
	const anomaly = all.filter((n) => n <= cursor).length > knownBelowCount;
	// On anomaly, rescan from the start and rebuild the cursor over the clean prefix; else fast path.
	const candidates = anomaly ? all : all.filter((n) => n > cursor);
	const emissions: Emission[] = [];
	let newCursor = anomaly ? "" : cursor;
	for (const name of candidates) {
		const full = join(sentDir, name);
		let stat;
		try {
			stat = lstatSync(full);
		} catch {
			break; // vanished mid-scan: barrier, retry next poll
		}
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
			newCursor = name; // not our data / oversize: a stable condition — skip past it
			continue;
		}
		let parsed: OutboxFile;
		try {
			parsed = JSON.parse(readFileSync(full, "utf8")) as OutboxFile;
		} catch {
			break; // partial/unparseable: transient barrier — leave the cursor before it, retry
		}
		newCursor = name;
		const sender = (typeof parsed.sender === "string" ? parsed.sender : "unknown").toLowerCase();
		const body = (typeof parsed.body === "string" ? parsed.body : "").slice(0, 500);
		emissions.push({
			schema_version: 1,
			id: uuidv5(`system-outbox:${name}`),
			type: "bot.message",
			ts,
			source: { service: "bridge", host: ".14", agent: null },
			subject: SUBJECT,
			subject_kind: "service",
			severity: severityOf(body),
			action: null,
			scope: "fleet",
			dimensions: { sender, message: body, file: name },
		});
	}
	return {
		emissions,
		cursor: newCursor,
		belowCount: all.filter((n) => n <= newCursor).length,
		anomaly,
	};
}
