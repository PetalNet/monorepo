// A Beeper client shows Matrix markdown raw, so outgoing text is converted to plain prose and numbered lines.
// Only the forms that client mangles are touched: **bold**, backticks, code fences, "- "/"* " bullets, # headers and
// [text](url) links. Code inside a fence is left exactly as written. Anything else passes through byte for byte.
const FENCE = /^\s*(```|~~~)[^`]*$/u; // a fence line may carry an info string (```js title), never another backtick
const HEADER = /^#{1,6}\s+/u;
// A line that opens with "#807" is read as a heading by lenient markdown parsers (marked pedantic: <h1>807 ...). A zero-width
// space in front stops that and shows as nothing in every client; a backslash would show literally in plain-body ones.
const REF_LINE = /^(\s*)(#\d+)/u;
const ZWSP = "\u200B";
const BULLET = /^(\s*)[-*]\s+/u;
const BOLD = /(^|[\s([{"'])\*\*(\S(?:[^*\n]*\S)?)\*\*(?=$|[\s.,;:!?)\]}"'])/gu;
const LINK = /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/gu;

// The markdown the old deny-only hook looked for. Anything still matching after conversion means the rewrite was not
// confident (e.g. 2**3, a link with a title), so the caller falls back to denying.
const DETECT: readonly (readonly [RegExp, string])[] = [
	[/\*\*[^*\n]+\*\*/u, "**bold**"],
	[/`/u, "backticks"],
	[/^\s*[-*] /mu, 'leading "- " bullet'],
	[/^#{1,6} /mu, "# header"],
	[/\[[^\]\n]+\]\(https?:/u, "[text](url) link"],
];

export const detect = (s: string): string[] =>
	DETECT.filter(([re]) => re.test(s)).map(([, n]) => n);

export function plain(text: string): { text: string; leftover: string[]; bareRefs: number } {
	const out: string[] = [];
	const prose: string[] = [];
	let bareRefs = 0;
	let inFence = false;
	// One [indent depth, running number] pair per open list level.
	let counters: [number, number][] = [];

	for (const line of text.split("\n")) {
		if (FENCE.test(line)) {
			inFence = !inFence;

			continue;
		}

		if (inFence) {
			out.push(line);

			continue;
		}

		let l = line;
		const b = BULLET.exec(l);

		if (b) {
			const indent = b[1] ?? "";
			const depth = indent.length;

			counters = counters.filter(([d]) => d <= depth);
			const top = counters.at(-1);
			let n = 1;

			if (top?.[0] === depth) {
				top[1] += 1;
				n = top[1];
			} else {
				counters.push([depth, 1]);
			}

			l = `${indent}${String(n)}. ${l.slice(b[0].length)}`;
		} else {
			if (l.trim()) {
				counters = [];
			}

			l = l.replace(HEADER, "");
		}

		if (REF_LINE.test(l)) {
			l = l.replace(REF_LINE, `$1${ZWSP}$2`);
			bareRefs++;
		}

		l = l
			.replace(BOLD, "$1$2")
			.replace(LINK, (_m, t: string, u: string) => (t === u ? u : `${t}: ${u}`))
			.replaceAll("`", "");

		out.push(l);
		prose.push(l);
	}

	// An unclosed fence would leave the rest of the message unconverted, so it is not something to send.
	return {
		text: out.join("\n"),
		leftover: inFence ? ["unclosed code fence"] : detect(prose.join("\n")),
		bareRefs,
	};
}
