// wake-filter: drop rules for a UserPromptSubmit hook on Janet's main Claude
// Code session (entry point: wake-filter.ts).
//
// Every Matrix message and every background-task notification reaches the
// session as a prompt, and every prompt is a wake: one API call that re-reads
// the whole context (~135K tokens). Some prompts never change what Janet does.
// This hook blocks a prompt when every item in it matches a drop rule below.
// A blocked prompt makes no API call. The drop is appended to
// ~/.claude/state/wake-filter.jsonl so it can be read back.
//
// A prompt with any item that matches no rule, or with any text outside the
// <channel>/<task-notification> blocks (a typed prompt), goes through whole.
// Rules name their sender and room, so nothing from a person can match.
// The ids and the person's name are deployment configuration, read from the environment (placeholders
// by default, so the rules match nothing until a deployment sets them).
// Any error lets the prompt through.

const fromEnv = (name: string, fallback: string) => {
	const v = process.env[name];

	return v === undefined || v === "" ? fallback : v;
};

export const MONITOR_SENDER = fromEnv("WAKE_FILTER_MONITOR_SENDER", "@monitor:example.org");
export const SYSTEM_ROOM = fromEnv("WAKE_FILTER_MONITOR_ROOM", "!monitor:example.org");
export const NOTES = fromEnv("WAKE_FILTER_NOTES_SENDER", "@notes:example.org");
export const NOTEBOOK_ROOM = fromEnv("WAKE_FILTER_NOTES_ROOM", "!notes:example.org");
// Who the job-watch FYI says it already messaged.
export const PERSON = fromEnv("WAKE_FILTER_PERSON", "the user");
// A disk alert at or above this percentage always wakes Janet, flap or not.
const DISK_ALWAYS_WAKE_PCT = 95;
// A WARN->FAIL disk crossing is a flap only if a FAIL->WARN for the same disk
// was dropped this recently. Otherwise it is the first FAIL and wakes Janet.
const DISK_FLAP_WINDOW_MS = 6 * 60 * 60 * 1000;

const ITEM =
	/<channel ([^>]*)>([\s\S]*?)<\/channel>|<task-notification>([\s\S]*?)<\/task-notification>/gu;
const ATTR = /(\w+)="([^"]*)"/gu;
// The channel prepends "[<room id> - <room name>] " and "[<sender>]: ".
const PREFIX = /^(\[![^\]]*\] )?\[[^\]]*\]: /u;
const tag = (xml: string, name: string) =>
	new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(xml)?.[1]?.trim();

const DISK =
	/^\[(warn|fail)\] (\S+): disk (\S+) now (WARN|FAIL):(\d+)% \(was (WARN|FAIL):(\d+)%\)$/u;

/** An earlier drop, as read back from the drop log. */
export interface Drop {
	readonly ts?: string;
	readonly rule?: string;
	readonly text?: string;
}
export interface Context {
	readonly history?: readonly Drop[];
	readonly now?: number;
}
/** One matched prompt item and the rule that dropped it. */
export interface Matched {
	readonly rule: string;
	readonly [key: string]: string | undefined;
}

// Shawn posts a disk alert only when its level changes, so one message can't
// tell a flap from a real crossing. FAIL->WARN by a point or two is always
// safe to drop. WARN->FAIL is dropped only right after such a drop.
function diskFlap(text: string, { history = [], now = Date.now() }: Context = {}) {
	const m = DISK.exec(text);

	if (!m) {
		return false;
	}

	const host = m[2];
	const mount = m[3];
	const level = m[4];
	const pct = m[5];
	const was = m[6];
	const wasPct = m[7];

	if (
		level === was ||
		Math.abs(Number(pct) - Number(wasPct)) > 2 ||
		Number(pct) >= DISK_ALWAYS_WAKE_PCT
	) {
		return false;
	}

	if (level === "WARN") {
		return true;
	}

	return history.some((d) => {
		const h = d.rule === "disk-flap" && d.text ? DISK.exec(d.text) : null;

		return (
			h &&
			h[2] === host &&
			h[3] === mount &&
			h[4] === "WARN" &&
			now - Date.parse(d.ts ?? "") < DISK_FLAP_WINDOW_MS
		);
	});
}

// One-line Shawn alerts only: a multi-line post could carry a second alert.
const oneLine = (re: RegExp) => (t: string) => !t.includes("\n") && re.test(t);

interface Rule {
	readonly name: string;
	readonly sender?: string;
	readonly room?: string;
	readonly text?: (t: string, ctx: Context) => boolean;
	readonly task?: (n: string) => boolean;
}

const escapeRegExp = (v: string) => v.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const RULES: readonly Rule[] = [
	{
		name: "subagent-waiting",
		// The harness sends this when a subagent ends its turn while its own
		// background work runs. The summary is not a report, and the same task id
		// notifies again when the subagent finishes. One that ends on a question
		// is kept, in case the question is for Janet.
		task: (n) =>
			tag(n, "status") === "completed" &&
			/^Agent "[^"]*" is waiting on its own background work$/u.test(tag(n, "summary") ?? "") &&
			!(tag(n, "result") ?? "").slice(-300).includes("?"),
	},
	{
		name: "disk-flap",
		sender: MONITOR_SENDER,
		room: SYSTEM_ROOM,
		text: (t, ctx) => !t.includes("\n") && diskFlap(t, ctx),
	},
	{
		name: "recovered",
		sender: MONITOR_SENDER,
		room: SYSTEM_ROOM,
		text: oneLine(/^\[recovered\] /u),
	},
	{
		name: "load-warn",
		sender: MONITOR_SENDER,
		room: SYSTEM_ROOM,
		text: oneLine(
			/^\[warn\] \S+: load now WARN:[\d.]+\/\d+cpu\(5m\) \(was OK:[\d.]+\/\d+cpu\(5m\)\)$/u,
		),
	},
	{
		name: "jobwatch-employers-fyi",
		// The FYI repeats roles job-watch already filed or DM'd; the TRIAGE post
		// and ERROR posts are not matched.
		sender: NOTES,
		room: NOTEBOOK_ROOM,
		text: (t) =>
			new RegExp(
				String.raw`^\[job-watch\] EMPLOYERS FYI: (filed \d+ new role\(s\) at watched employers \(not DM'd\)|already DM'd ${escapeRegExp(PERSON)} \d+ new role\(s\) at watched employers; do not re-send)`,
				"u",
			).test(t),
	},
];

// Channel attributes, or null when a key repeats (a forged attribute, say
// from a display name with a quote in it) or the source isn't the channel.
function channelAttrs(raw: string) {
	const a: Record<string, string> = {};

	for (const [, k = "", v = ""] of raw.matchAll(ATTR)) {
		if (k in a) {
			return null;
		}

		a[k] = v;
	}

	return a["source"] === "claude-matrix-channel" ? a : null;
}

// Returns the matched items when every item in the prompt matches a rule, else
// null. ctx.history holds earlier drops (log records); ctx.now is the time.
export function classify(prompt: unknown, ctx: Context = {}): Matched[] | null {
	if (typeof prompt !== "string") {
		return null;
	}

	const items = [...prompt.matchAll(ITEM)];

	if (items.length === 0 || prompt.replace(ITEM, "").trim() !== "") {
		return null;
	}

	const drops: Matched[] = [];

	for (const m of items) {
		if (m[3] !== undefined) {
			const body = m[3];
			const hit = RULES.find((r) => r.task?.(body));

			if (!hit) {
				return null;
			}

			drops.push({ rule: hit.name, task_id: tag(body, "task-id"), summary: tag(body, "summary") });

			continue;
		}

		const a = channelAttrs(m[1] ?? "");

		if (!a) {
			return null;
		}

		const text = (m[2] ?? "").trim().replace(PREFIX, "").trim();

		// '">' in the body means an attribute value broke out of its quotes.
		if (text.includes('">')) {
			return null;
		}

		const hit = RULES.find(
			(r) => r.text && r.sender === a["sender_id"] && r.room === a["room_id"] && r.text(text, ctx),
		);

		if (!hit) {
			return null;
		}

		drops.push({
			rule: hit.name,
			sender: a["sender_id"],
			room: a["room_id"],
			event_id: a["event_id"],
			text: text.slice(0, 300),
		});
	}

	return drops;
}
