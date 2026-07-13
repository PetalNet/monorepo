// System-outbox source (N1b-3, PHASE1B-DESIGN §3 — the /task/681 driving use case). The lab's
// service bots (shawn/derek/michael) drop warnings as JSON files; today they flood Matrix. This
// tailer maps known operational messages to their statistic types and preserves unknown messages as
// `bot.message`, so the console consumes them and Matrix can eventually go quiet.

import { createHash } from "node:crypto";
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
	readonly reason: "invalid_json" | "non_regular" | "oversize" | "unreadable";
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
	readonly belowHash: string;
	/** A file appeared at/below the cursor (non-monotonic insert); this pass rescanned to recover it. */
	readonly anomaly: boolean;
	/** Stable records skipped deliberately; the caller must emit gap + quarantine metadata. */
	readonly losses: readonly TailLoss[];
}

export function sourceCursorRef(file: string): string {
	return uuidv5(`system-outbox-cursor:${file}`);
}

function namesHash(names: readonly string[]): string {
	return names.length === 0
		? ""
		: createHash("sha256").update(names.join("\0"), "utf8").digest("hex");
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
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") return { kind: "loss", reason: "non_regular" };
		if (code === "EACCES" || code === "EPERM") return { kind: "loss", reason: "unreadable" };
		return { kind: "barrier" }; // vanished or transient resource/I/O failure: retry next poll
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
	if (disk?.[1] === ".14" && disk[2])
		return {
			type: "host.disk.pct",
			subject: ".14",
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
			subject: SUBJECT,
			subjectKind: "service",
			dimensions: { claimed_container: container[1].toLowerCase() },
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
 * - A vanished/transiently unreadable file is a BARRIER: stop there and retry next poll.
 * - Malformed, permission-denied, non-regular, and oversize files are stable poison in the daemon's
 *   atomic-rename `sent/`; they are returned as losses for quarantine + gap signaling.
 * - Wrong-typed fields are coerced with safe defaults, never thrown on (one malformed record must not
 *   mark the entire source dark).
 *
 * Late/non-monotonic filenames — the producer writes strictly increasing nanosecond names into an
 * append-only `sent/`, so the fast path only looks at names `> cursor`. But a misbehaving producer
 * could drop a name at/below the cursor, which the fast path would miss forever. A persisted count
 * AND filename-set digest detects additions, pruning, and equal-count replacements. On drift we
 * flag an anomaly and rescan every file this pass — the deterministic id dedups everything already
 * in the lake, so the only cost is a re-read. At-least-once delivery throughout.
 */
export function tailSystemOutbox(
	dir: string,
	cursor: string,
	knownBelowCount: number,
	ts: string,
	knownBelowHash?: string,
	beforeOpen?: (path: string, name: string) => void,
): TailResult {
	const sentDir = join(dir, "sent");
	const all = readdirSync(sentDir)
		.filter((n) => n.endsWith(".json"))
		.sort();
	const below = all.filter((n) => n <= cursor);
	const anomaly =
		below.length !== knownBelowCount ||
		(knownBelowHash !== undefined && namesHash(below) !== knownBelowHash);
	// On anomaly, rescan from the start and rebuild the cursor over the clean prefix; else fast path.
	const candidates = anomaly ? all : all.filter((n) => n > cursor);
	const emissions: Emission[] = [];
	const losses: TailLoss[] = [];
	let newCursor = anomaly ? "" : cursor;
	for (const name of candidates) {
		const full = join(sentDir, name);
		beforeOpen?.(full, name);
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
			// sent/ is populated by atomic rename after the daemon parses JSON; malformed JSON here is
			// therefore stable poison and must not stall every later record.
			losses.push({ file: name, reason: "invalid_json" });
			newCursor = name;
			continue;
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
			dimensions: {
				sender,
				message: body,
				file_ref: sourceCursorRef(name),
				...operational?.dimensions,
			},
			measures: operational?.measures,
			meta: operational?.meta,
		});
	}
	return {
		emissions,
		cursor: newCursor,
		belowCount: all.filter((n) => n <= newCursor).length,
		belowHash: namesHash(all.filter((n) => n <= newCursor)),
		anomaly,
		losses,
	};
}
