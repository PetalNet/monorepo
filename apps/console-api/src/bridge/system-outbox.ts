// System-outbox source (N1b-3, PHASE1B-DESIGN §3 — the /task/681 driving use case). The lab's
// service bots (shawn/derek/michael) drop warnings as JSON files; today they flood Matrix. This
// tailer maps known operational messages to their statistic types and preserves unknown messages as
// `bot.message`, so the console consumes them and Matrix can eventually go quiet.

import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Emission } from "../emission.ts";
import { uuidv5 } from "./uuid5.ts";

interface OutboxFile {
	sender?: unknown;
	body?: unknown;
}

export interface TailLoss {
	readonly file: string;
	readonly reason: "non_regular" | "oversize";
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
	/** Stable records skipped deliberately; the caller must emit gap + quarantine metadata. */
	readonly losses: readonly TailLoss[];
}

type ReadResult =
	| { readonly kind: "ok"; readonly raw: string }
	| { readonly kind: "loss"; readonly reason: TailLoss["reason"] }
	| { readonly kind: "barrier" };

function readRegularFile(path: string): ReadResult {
	let fd: number;
	try {
		// O_NOFOLLOW closes the lstat/read TOCTOU window: even a swap immediately before open fails.
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ELOOP"
			? { kind: "loss", reason: "non_regular" }
			: { kind: "barrier" };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { kind: "loss", reason: "non_regular" };
		if (stat.size > MAX_FILE_BYTES) return { kind: "loss", reason: "oversize" };
		return { kind: "ok", raw: readFileSync(fd, "utf8") };
	} finally {
		closeSync(fd);
	}
}

function operationalType(body: string): {
	type: string;
	subject: string;
	subjectKind: Emission["subject_kind"];
	dimensions?: Record<string, string | boolean>;
	measures?: Record<string, number>;
	meta?: Emission["meta"];
} | null {
	const disk =
		/(?:host\s+)?(\.\d+|[a-z0-9][a-z0-9.-]*)\s+disk[^\n]{0,40}?(\d+(?:\.\d+)?)\s*%/i.exec(body);
	if (disk?.[1] && disk[2])
		return {
			type: "host.disk.pct",
			subject: disk[1].toLowerCase(),
			subjectKind: "host",
			measures: { pct: Number(disk[2]) },
			meta: { fields: { pct: { unit: "percent", kind: "gauge", cardinality: "low" } } },
		};
	const container = /container\s+([a-z0-9][a-z0-9_.-]*)[^\n]{0,100}?update(?:s)?\s+available/i.exec(
		body,
	);
	if (container?.[1])
		return {
			type: "container.update_available",
			subject: container[1].toLowerCase(),
			subjectKind: "service",
			dimensions: { container: container[1].toLowerCase() },
		};
	const box =
		/box\s+(\.\d+|[a-z0-9][a-z0-9.-]*)[^\n]{0,100}?update status (?:changed|is)\s*:?\s*([a-z_ -]+)/i.exec(
			body,
		);
	if (box?.[1])
		return {
			type: "box.update_status_changed",
			subject: box[1].toLowerCase(),
			subjectKind: "host",
			dimensions: { status: (box[2] ?? "changed").trim().slice(0, 64) },
		};
	return null;
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
	const losses: TailLoss[] = [];
	let newCursor = anomaly ? "" : cursor;
	for (const name of candidates) {
		const full = join(sentDir, name);
		let read: ReadResult;
		try {
			read = readRegularFile(full);
		} catch {
			break; // vanished mid-scan: barrier, retry next poll
		}
		if (read.kind === "barrier") break;
		if (read.kind === "loss") {
			losses.push({ file: name, reason: read.reason });
			newCursor = name; // not our data / oversize: a stable condition — skip past it
			continue;
		}
		let parsed: OutboxFile;
		try {
			const value: unknown = JSON.parse(read.raw);
			parsed = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		} catch {
			break; // partial/unparseable: transient barrier — leave the cursor before it, retry
		}
		newCursor = name;
		const sender = (typeof parsed.sender === "string" ? parsed.sender : "unknown")
			.toLowerCase()
			.slice(0, 128);
		const body = (typeof parsed.body === "string" ? parsed.body : "").slice(0, 500);
		const operational = operationalType(body);
		emissions.push({
			schema_version: 1,
			id: uuidv5(`system-outbox:${name}`),
			type: operational?.type ?? "bot.message",
			ts,
			source: { service: "bridge", host: ".14", agent: null },
			subject: operational?.subject ?? SUBJECT,
			subject_kind: operational?.subjectKind ?? "service",
			severity: severityOf(body),
			action: null,
			scope: "fleet",
			dimensions: { sender, message: body, file: name, ...operational?.dimensions },
			measures: operational?.measures,
			meta: operational?.meta,
		});
	}
	return {
		emissions,
		cursor: newCursor,
		belowCount: all.filter((n) => n <= newCursor).length,
		anomaly,
		losses,
	};
}
