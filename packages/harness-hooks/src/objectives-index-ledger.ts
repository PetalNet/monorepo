// The open-objectives ledger (~/.claude/shared/open-objectives.md) as blocks, so it can be indexed and pruned
// without losing a line. An item is a top-level "- " bullet plus every line up to the next bullet or header, so a
// numbered sub-step stays with its item. Everything else (headers, prose, the numbered master backlog under its own
// header) is a text block.
import { createHash } from "node:crypto";

/** A ledger bullet (with its continuation lines) or a run of other lines. */
export interface Block {
	kind: "item" | "text";
	lines: string[];
	id?: string;
	title?: string | null;
}
interface Item extends Block {
	kind: "item";
	id: string;
	title: string | null;
}

const BREAK = /^(- |#{1,6} )/u;

export function parse(text: string): Block[] {
	const blocks: Block[] = [];

	for (const line of text.split("\n")) {
		const last = blocks.at(-1);

		if (line.startsWith("- ")) {
			blocks.push({ kind: "item", lines: [line] });
		} else if (last?.kind === "item" && !BREAK.test(line)) {
			last.lines.push(line);
		} else if (last?.kind === "text") {
			last.lines.push(line);
		} else {
			blocks.push({ kind: "text", lines: [line] });
		}
	}

	const seen = new Map<string, number>();

	for (const b of blocks) {
		if (b.kind === "item") {
			const first = b.lines[0] ?? "";
			const base = itemId(first);
			const n = (seen.get(base) ?? 0) + 1;

			seen.set(base, n);
			b.id = n === 1 ? base : `${base}~${String(n)}`;
			b.title = title(first);
		}
	}

	return blocks;
}

export const render = (blocks: readonly Block[]) => blocks.flatMap((b) => b.lines).join("\n");

// Stable across edits to an item's body: the [#N] tag, else the bold title, else a hash of the head's start.
function itemId(head: string) {
	const tagged = /\[#(\d+)\]/u.exec(head);

	if (tagged) {
		return `#${tagged[1] ?? ""}`;
	}

	const t = title(head);

	if (t) {
		return t
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-|-$/gu, "")
			.slice(0, 60);
	}

	return `h:${createHash("sha1").update(head.slice(0, 100)).digest("hex").slice(0, 10)}`;
}

function title(head: string) {
	const m = /^- [^*]{0,12}\*\*(.+?)\*\*/u.exec(head);

	return m ? (m[1] ?? "").replace(/\[#\d+\]\s*/u, "").trim() : null;
}

// Open work: anything waiting, blocked, queued, pending or with a next step. Over-matching only keeps an item live.
export const OPEN =
	/\bWAIT(ING|S)?\b|waiting|\bnext( action)?:|\bTODO\b|BLOCKED|READY-ON-GO|\bHARD\b|\bACTIVE\b|in progress|🔄|\bpending\b|\bQUEUED\b|\bOPEN\b|asked (Parker|Eli)|not yet|still (need|missing|open)|follow-?ups?|\bTARGET\b|\bwatch\b|⚠|\byet\b|re-?running|\bresum|\basks?\b|my call|unanswered|\bdecid|\bdecision|\bmorning\b|\bstill\b|running|\bplan|schedul|on deploy|\bthen\b|\bbug\b|\bsend\b|committed|draft|offer|\bnext\b|\bwill\b|\bafter\b|\bonce\b|\buntil\b|remaining|\bQ\b|question|to do\b|\bwhile\b|parked|untried|fixing/iu;

const DONE =
	/✅|\bDONE\b|RESOLVED|MERGED|DELIVERED|SUBMITTED|\bLIVE\b|\bFIXED\b|SUPERSEDED|CLOSED|COMPLETE|\bAPPLIED\b|\bSKIPPED\b/u;

// Archivable: a finished marker and no open marker anywhere in the item.
export function archivable(item: Block) {
	const body = item.lines.join("\n");

	return DONE.test(body) && !OPEN.test(body);
}

// Cuts on code points, so an emoji is never split into a lone surrogate (which makes the hook's JSON invalid).
const clip = (s: string, n: number) => {
	const c = Array.from(s);

	return c.length > n
		? `${c
				.slice(0, n - 1)
				.join("")
				.trimEnd()}…`
		: s;
};

const field = (body: string, re: RegExp) =>
	re.exec(body)?.[1]?.replace(/\*\*/gu, "").replace(/\s+/gu, " ").trim();

export function state(item: Block) {
	const body = item.lines.join(" ");
	const s = field(body, /\bstate:\s*([^·]+)/iu);

	if (s) {
		return s;
	}

	const m = /\b(WAITING|WAIT|BLOCKED|READY-ON-GO|ACTIVE|QUEUED|HARD|in progress|pending)\b/iu.exec(
		body,
	);

	return m ? (m[1] ?? "").toUpperCase() : "open";
}

export const next = (item: Block) => {
	const body = item.lines.join(" ");

	return (
		[field(body, /\bnext(?: action)?:\s*([^·]+)/iu), field(body, /\bwaiting-on:\s*([^·]+)/iu)].find(
			Boolean,
		) ?? ""
	);
};

// One line per titled live item with its state and next step, capped at maxBytes; whatever does not fit is counted
// and left in the file. Items whose state says they wait or are blocked come first, then the rest, newest first
// within each group (the ledger is appended to).
const URGENT = /WAIT|BLOCKED|HARD|PENDING|QUEUED|ACTIVE|READY/iu;

export function index(
	blocks: readonly Block[],
	{ path, maxBytes = 6000 }: { path: string; maxBytes?: number },
) {
	const items = blocks.filter((b) => b.kind === "item") as Item[];
	const newest = items.filter((b) => b.title).toReversed();
	const titled = [
		...newest.filter((b) => URGENT.test(state(b))),
		...newest.filter((b) => !URGENT.test(state(b))),
	];
	const head =
		`OPEN OBJECTIVES (index of ${path}; ${String(items.length)} live entries, ${String(titled.length)} titled). ` +
		"Re-engage anything ACTIVE and check whether any WAITING condition is now met. Waiting/blocked first, then newest. Details: grep the title in the file.\n";
	const lines = titled.map(
		(b) =>
			`- ${clip((b.title ?? "").replace(/^[^\p{L}\p{N}[(]+/u, ""), 50)} | ${clip(state(b), 32)}${next(b) ? ` | next: ${clip(next(b), 56)}` : ""}`,
	);
	const backlog = blocks
		.filter((b) => b.kind === "text")
		.flatMap((b) => b.lines)
		.filter((l) => /^\d+\. /u.test(l)).length;
	const tail = `\n${String(items.length - titled.length)} untitled log entries${backlog ? ` and ${String(backlog)} numbered master-backlog lines` : ""} are in the file.\n`;
	let out = head;
	let shown = 0;

	for (const l of lines) {
		const more = `\n…${String(lines.length - shown - 1)} more titled entries: read the file.`;

		if (Buffer.byteLength(`${out}${l}\n${more}${tail}`) > maxBytes) {
			out += `…${String(lines.length - shown)} more titled entries: read the file.\n`;

			break;
		}

		out += `${l}\n`;
		shown++;
	}

	return out + tail;
}

// The prune as data: the new ledger text and the text to archive.
export function prunePlan(original: string) {
	const blocks = parse(original);
	const moved = blocks.filter((b) => b.kind === "item" && archivable(b));

	return {
		moved,
		newLedger: render(blocks.filter((b) => !moved.includes(b))),
		archived: render(moved),
	};
}

// Re-parses the texts that would be written (not the in-memory partition) and reports what an invariant break would
// lose: items gone from both files, items with an open marker gone from the ledger, and any line not accounted for.
export function verify(original: string, newLedger: string, archived: string) {
	const items = (text: string) => (text ? parse(text).filter((b) => b.kind === "item") : []);
	const body = (b: Block) => b.lines.join("\n");
	const bag = (bs: readonly Block[]) => {
		const m = new Map<string, number>();

		for (const b of bs) {
			m.set(body(b), (m.get(body(b)) ?? 0) + 1);
		}

		return m;
	};

	const take = (m: Map<string, number>, k: string) => {
		const n = m.get(k) ?? 0;

		if (n > 0) {
			m.set(k, n - 1);

			return true;
		}

		return false;
	};

	const before = items(original);
	const live = items(newLedger);
	const gone = items(archived);
	const anywhere = bag([...live, ...gone]);
	const inLedger = bag(live);
	const sortedLines = (t: string) => t.split("\n").toSorted().join("\n");

	return {
		items: before.length,
		live: live.length,
		archived: gone.length,
		openItems: before.filter((b) => OPEN.test(body(b))).length,
		lost: before.filter((b) => !take(anywhere, body(b))).map((b) => b.id),
		openDropped: before
			.filter((b) => OPEN.test(body(b)) && !take(inLedger, body(b)))
			.map((b) => b.id),
		linesKept:
			sortedLines(original) === sortedLines(archived ? `${newLedger}\n${archived}` : newLedger),
	};
}
