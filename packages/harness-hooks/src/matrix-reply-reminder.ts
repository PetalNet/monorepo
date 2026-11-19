// Stop hook that makes "no reply" a deliberate choice. A turn that ends after a human Matrix message must contain a
// reply tool call (hermes-link send_message / send_file / react / mc_reply, or the old matrix_reply family) or the
// marker [[silent-noop: reason]], else the stop is blocked (twice at most, then the on-disk loop breaker lets it end).
// Inbound reactions (kind="reaction") and non-human triggers owe nothing.
//
// Recap gate: once the reply gate passes, a main-thread final text over 300 characters (marker excluded) whose last
// paragraph asks nothing is a terminal recap, so the stop is blocked once with "end with only [[silent-noop: ...]] or
// one short line". Nobody reads the terminal; Matrix already has the content. The next stop of the same transcript
// always ends the turn. Subagents are exempt.
//
// THE LOAD-BEARING PART IS THE ON-DISK COUNTER, NOT THE TRANSCRIPT SCAN. The transcript is a lagging, unreliable
// view: a hook that gated only on parsing it looped an agent through blocks whose marker was already in the file. The
// persisted consecutive-block counter is what guarantees termination; the scan only avoids nagging when it works.
// The counter is keyed per transcript, because $HOME is shared by every agent on the machine and a single shared file
// let one agent's successful turn clear another agent's live streak.
//
// Which senders owe a reply: MATRIX_REPLY_HUMAN_PATTERN (a regular expression source) overrides the placeholder default.
//
// One file with no dependencies: `node matrix-reply-reminder.ts < payload.json`.
import { createHash } from "node:crypto";
import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

const TAIL_BYTES = 4 * 1024 * 1024; // plenty for one turn; keeps huge sessions cheap
const MAX_BLOCKS = 2; // consecutive blocks allowed before we let the turn end
const NUDGE_TURNS = 5; // arm the adaptive UserPromptSubmit reminder for N turns after a slip
const RECAP_MIN_CHARS = 300; // a final text longer than this, with no question pending, is a recap
const RECAP_MAX_BLOCKS = 1; // a recap stop is blocked once; the stop after that always ends the turn
const RETRIES = 4;
const RETRY_WAIT_MS = 400;

// Humans whose messages owe a reply.
const humanPattern = () =>
	new RegExp(
		process.env["MATRIX_REPLY_HUMAN_PATTERN"] ??
			String.raw`@human-a:example\.org|@human-b:example\.org|Player \(Minecraft\)`,
		"u",
	);

// Marker that declares a deliberate silent turn; it is not prose, so it never counts toward a recap.
const NOOP_MARKER = /\[\[\s*silent-noop[^\]]*\]\]/giu;
const NOOP_START = /\[\[\s*silent-noop/iu;
const REPLY_TOOL =
	/matrix_reply|mc_reply|matrix_send_file|matrix_react|mcp__hermes-link__(send_message|send_file|react|mc_reply)/u;

// Our own re-prompt, injected as a meta user entry when we block.
const GATE_FEEDBACK = /Stop hook feedback:[\s\S]*COMMS GATE/u;
const HUMAN_SOURCE = /source=\\?"(?:claude-matrix-channel|hermes-link)\\?"/u;
const REACTION = /kind=\\?"reaction\\?"/u;

interface Block {
	readonly type?: unknown;
	readonly name?: unknown;
	readonly text?: unknown;
}

interface Entry {
	readonly type?: unknown;
	readonly message?: { readonly role?: unknown; readonly content?: unknown };
}

interface HookInput {
	readonly agent_id?: unknown;
	readonly transcript_path?: unknown;
	readonly last_assistant_message?: unknown;
	readonly stop_hook_active?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const blocksOf = (content: unknown): Block[] | null =>
	Array.isArray(content) ? (content as unknown[]).filter((c): c is Block => isObject(c)) : null;

// Read only the last TAIL_BYTES of the transcript. A truncated leading line just fails JSON.parse and is skipped.
function readTail(path: string): string | null {
	let fd: number | undefined;

	try {
		fd = openSync(path, "r");

		const size = fstatSync(fd).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const len = size - start;
		const buf = Buffer.alloc(len);

		readSync(fd, buf, 0, len, start);

		return buf.toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// nothing to release
			}
		}
	}
}

function parseLine(line: string): Entry | null {
	try {
		const o: unknown = JSON.parse(line);

		return isObject(o) ? o : null;
	} catch {
		return null;
	}
}

/**
 * `true` = nothing owed or already satisfied, `false` = a human message went unanswered, `null` =
 * transcript unreadable.
 */
export function scan(raw: string | null, human: RegExp): boolean | null {
	if (raw === null) {
		return null;
	}

	const lines = raw.trim().split("\n");
	let sawReply = false;
	let sawNoop = false;
	let gateBlocks = 0; // how many times we've already blocked since the real trigger

	for (let i = lines.length - 1; i >= 0; i--) {
		const o = parseLine(lines[i] ?? "");

		if (o === null) {
			continue;
		}

		const content = o.message?.content;
		const isAssistant = o.message?.role === "assistant" || o.type === "assistant";
		const blocks = blocksOf(content);

		for (const c of blocks ?? []) {
			if (c.type === "tool_use" && REPLY_TOOL.test(typeof c.name === "string" ? c.name : "")) {
				sawReply = true;
			}

			if (
				c.type === "text" &&
				isAssistant &&
				typeof c.text === "string" &&
				NOOP_START.test(c.text)
			) {
				sawNoop = true;
			}
		}

		if (o.message?.role === "user" || o.type === "user") {
			if (blocks?.some((c) => c.type === "tool_result")) {
				continue;
			}

			const s = typeof content === "string" ? content : JSON.stringify(content ?? "");

			// Our own injected re-prompt is NOT a turn trigger: count it and keep going, otherwise a marker written
			// on an earlier attempt stays invisible forever.
			if (GATE_FEEDBACK.test(s)) {
				gateBlocks++;

				continue;
			}

			// Only a human Matrix message owes a reply. Background-task notifications and other non-human triggers
			// are walked past; if a reply (or marker) already happened after the latest human message, or none is in
			// the tail at all, nothing is owed and no marker is needed.
			if (!HUMAN_SOURCE.test(s) || !human.test(s)) {
				continue;
			}

			// An inbound reaction owes nothing either.
			if (REACTION.test(s)) {
				continue;
			}

			return gateBlocks >= MAX_BLOCKS || sawReply || sawNoop;
		}
	}

	// No human Matrix message anywhere in the tail: nothing is owed.
	return true;
}

// The turn's final assistant text. Claude Code puts it in the Stop payload as last_assistant_message; fall back to
// the transcript tail when an older harness omits it. null = unknown (the turn ends in a tool call, or the
// transcript lags): never block on a guess.
function finalAssistantText(input: HookInput, transcript: string): string | null {
	if (typeof input.last_assistant_message === "string") {
		return input.last_assistant_message;
	}

	const raw = readTail(transcript);

	if (raw === null) {
		return null;
	}

	const lines = raw.trim().split("\n");

	for (let i = lines.length - 1; i >= 0; i--) {
		const o = parseLine(lines[i] ?? "");

		if (o === null) {
			continue;
		}

		const role = o.message?.role ?? o.type;

		if (role !== "assistant") {
			if (role === "user") {
				return null;
			}

			continue;
		}

		const content = o.message?.content;

		if (typeof content === "string") {
			return content;
		}

		if (!Array.isArray(content) || content.length === 0) {
			continue;
		}

		const last: unknown = content[content.length - 1];

		if (isObject(last) && last["type"] === "tool_use") {
			return null;
		}

		return (blocksOf(content) ?? [])
			.flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : []))
			.join("\n");
	}

	return null;
}

/**
 * A recap is prose after the work that repeats what Matrix already carries: long, with no question
 * left for the human.
 */
export function isRecap(text: string): boolean {
	const prose = text.replace(NOOP_MARKER, "").trim();

	if (prose.length <= RECAP_MIN_CHARS) {
		return false;
	}

	const paragraphs = prose.split(/\n\s*\n/u);
	// A '?' inside a URL query or a quoted phrase is not a question to the human.
	const last = (paragraphs[paragraphs.length - 1] ?? "")
		.replace(/https?:\/\/\S+/gu, "")
		.replace(/["“][^"”\n]*["”]/gu, "");

	return !last.includes("?");
}

const sleepSync = (ms: number) => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const readCount = (file: string) => {
	try {
		return Number.parseInt(readFileSync(file, "utf8").trim(), 10) || 0;
	} catch {
		return 0;
	}
};

const writeQuiet = (file: string, value: string) => {
	try {
		writeFileSync(file, value);
	} catch {
		// the counters are best effort
	}
};

const digest = (transcript: string) =>
	createHash("sha1").update(transcript).digest("hex").slice(0, 12);

const COMMS_REASON =
	"COMMS GATE: this turn ended with no matrix_reply AND no explicit silent-noop. The humans see ONLY Matrix. Either send your reply now via mcp__hermes-link__send_message (with the right room; old harness: mcp__claude-matrix-channel__matrix_reply with room_id), OR — if you have genuinely, deliberately decided this turn warrants no message (e.g. background work, or letting a fast human thread breathe) — declare it by writing the marker [[silent-noop: <one-line reason>]]. Silence must be an explicit choice, never the default.";

function main(input: HookInput): void {
	// Subagent tool calls carry agent_id; the main loop does not. The comms rule is the main agent's alone.
	if (input.agent_id) {
		return;
	}

	const tp = input.transcript_path;

	if (typeof tp !== "string" || tp === "") {
		return;
	}

	const transcript = tp;
	const env = process.env;
	const home = [env["HOME"], env["USERPROFILE"]].find((v) => v !== undefined && v !== "") ?? "";
	const blockDir = `${home}/.claude/state`;
	const key = digest(transcript);
	const blockCount = `${blockDir}/comms-block-${key}`;

	try {
		mkdirSync(blockDir, { recursive: true });
	} catch {
		// the counters are best effort
	}

	const human = humanPattern();
	let ok = scan(readTail(transcript), human);

	// The harness may run Stop hooks before the turn's final assistant message is flushed to the transcript file, so
	// a would-block result waits and re-reads. null (transcript unreadable) is a transient IO condition, not
	// evidence of silence, so it retries like false.
	for (let attempt = 0; (ok === false || ok === null) && attempt < RETRIES; attempt++) {
		sleepSync(RETRY_WAIT_MS);
		ok = scan(readTail(transcript), human);
	}

	if (ok === true) {
		// Replied (or legitimately silent): clear the streak.
		writeQuiet(blockCount, "0");
	}

	if (ok === false) {
		// Unconditional loop breaker: reasoning about why the scan keeps returning false has failed, counting our own blocks cannot.
		const streak = readCount(blockCount);

		if (streak >= MAX_BLOCKS) {
			writeQuiet(blockCount, "0");

			return; // let the turn end; nagging further is pure token burn
		}

		writeQuiet(blockCount, String(streak + 1));
		writeQuiet(`${home}/.claude/state/comms-nudge`, String(NUDGE_TURNS)); // arm the adaptive reminder
		console.log(JSON.stringify({ decision: "block", reason: COMMS_REASON }));
	}

	if (ok === true) {
		// Terminal recap gate. At most one block per stop streak, counted on disk like the comms gate.
		const recapCount = `${blockDir}/recap-block-${key}`;
		const text = finalAssistantText(input, transcript);
		const streak = readCount(recapCount);

		// stop_hook_active: this stop already follows a hook block, so never block again even if the disk counter failed.
		if (text !== null && !input.stop_hook_active && isRecap(text) && streak < RECAP_MAX_BLOCKS) {
			writeQuiet(recapCount, String(streak + 1));

			console.log(
				JSON.stringify({
					decision: "block",
					reason: `RECAP GATE: your final text is a terminal recap (${String(text.length)} chars). Nobody reads the terminal; Matrix already carries what you did. End the turn with only [[silent-noop: <few words>]] or one short line under ${String(RECAP_MIN_CHARS)} characters. Do not summarise again.`,
				}),
			);
		} else {
			writeQuiet(recapCount, "0");
		}
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	let input: unknown;

	try {
		input = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		process.exit(0);
	}

	if (isObject(input)) {
		main(input);
	}

	process.exit(0);
}
