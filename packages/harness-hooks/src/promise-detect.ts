// Deterministic detector for deferred promises in an agent's outgoing chat messages: a commitment that the agent, or
// work it is running, will deliver or do something for the reader later. Patterns only; no text leaves the process.
// Tuned toward recall: a false positive costs one automatic close or one reminder line, a miss is a promise nobody
// tracks. Conditional offers that wait on the reader and reports of finished work are not promises.

export type PromiseKind = "future" | "delivery" | "working";

export interface Detected {
	/** The sentence that carries the promise, whitespace collapsed. */
	sentence: string;
	/**
	 * Future: "I'll ..."; delivery: "you'll get ...", "... to follow"; working: "on it", "checking
	 * now".
	 */
	kind: PromiseKind;
}

const APOS = "(?:'|’)";

// An offer that only happens if the reader answers, chooses or supplies something.
const CONDITIONAL = new RegExp(
	[
		String.raw`\bwant me to\b`,
		String.raw`\bwant (?:that|this|it|one|them)\b`,
		String.raw`\b(?:should|shall|can|could) I\b`,
		String.raw`\b(?:do|would) you (?:want|like|prefer)\b`,
		String.raw`\bsay the word\b`,
		String.raw`\b(?:if|when|once|unless|until) you(?:${APOS}d| would)? (?:want|like|prefer|say|give|send|tell|need|pick|choose|decide|confirm|approve|agree|think|mean|have)\b`,
		String.raw`\bif (?:you${APOS}re|you are|he|she|they|that works|so)\b`,
		String.raw`\b(?:say|send|ping|tell|give|pick|choose|reply|message|let|share|paste|approve|confirm)\b[^.!?]{0,90}\band (?:I|it)(?:${APOS}ll| will)\b`,
		String.raw`\b(?:your|his|her|their) (?:go|ok|okay|call|pick|choice|answer|approval|go-ahead)\b`,
	].join("|"),
	"iu",
);

// A standing rule about how the agent behaves, not a deliverable.
const RULE = new RegExp(
	String.raw`\bI(?:${APOS}ll| will) (?:only|never|always)\b|\b(?:from now on|going forward|in future|every time|whenever)\b`,
	"iu",
);

const FUTURE = new RegExp(
	String.raw`\b(?:I|we)(?:${APOS}ll| will)\b|\b(?:I${APOS}m|I am|we${APOS}re) (?:going to|gonna)\b|\blet me\b`,
	"iu",
);

const DELIVERY = new RegExp(
	[
		String.raw`\byou(?:${APOS}ll| will) (?:get|have|see|be able|hear|receive|find|know)\b`,
		String.raw`\b(?:it|that|this|they|he|she|which|there)${APOS}ll\b`,
		String.raw`\bcomes? (?:back )?(?:to you|as|with)\b`,
		String.raw`\b(?:to follow|still to come|to come)\b`,
		String.raw`\b(?:coming|arriving|landing|following) (?:next|soon|shortly|tomorrow|tonight|later|up|after)\b`,
		String.raw`\bwill\b`,
		String.raw`\b(?:lands?|arrives?|ships?|comes?|goes out|follows?)\b[^.!?]*\b(?:within|soon|shortly|tonight|tomorrow|next|later|in a (?:few|couple)|in \d+)\b`,
		String.raw`\b(?:coming|incoming)\s*[.!]?$`,
		String.raw`\b(?:when|once|after|as soon as) (?:it|that|this|they|he|she|the \w+)(?:${APOS}s| is| are|${APOS}re)? (?:green|live|up|done|merged|ready|pushed|built|verified|finished|back|out|in)\b`,
		String.raw`\bI owe you\b`,
		String.raw`\b(?:goes|go|going) (?:in|into|out|live|up)\b`,
		String.raw`\bnext\b[^.!?]{0,40}\b(?:should|is|comes|up)\b`,
		String.raw`\bthen I\b|\bthen (?:it|he|she|they|we)(?:${APOS}ll| will| goes?| gets?| comes?| lands?)\b`,
		String.raw`\b(?:once|after|when|as soon as|until) [^.!?,]{3,70}\b(?:lands|merges|finishes|is done|is live|is up|is green|passes|comes back|is merged|is back|resets?|points)\b`,
	].join("|"),
	"iu",
);

const STATIVE =
	"(?:not|still|just|also|waiting|holding|guessing|assuming|seeing|thinking|missing|using|keeping|leaving|treating|reading that|sorry|sure|glad|happy|afraid|aware)";
const WORKING = new RegExp(
	[
		String.raw`\bon it\b`,
		String.raw`\b(?:I${APOS}m|I am) (?!${STATIVE}\b)\w+ing\b`,
		String.raw`^(?:\w+ing)\b[^.!?]*\bnow\b`,
		String.raw`^(?:adding|going with|restarting|starting|running|building|checking|looking|fixing|sending|pulling|working|deploying|downloading|merging|updating|drafting|testing)\b(?![^.!?]*\b(?:is|means|fixes|needs|would|takes|was|costs)\b)`,
		String.raw`\bis \w+ing\b[^.!?]*\bnow\b`,
		String.raw`\b(?:being|getting) \w+(?:ed|t|n)\b[^.!?]*\bnow\b`,
		String.raw`\b\w+ing (?:it|that|them|this) now\b`,
		String.raw`\bnext\s*[.:]?$`,
	].join("|"),
	"iu",
);

/**
 * Splits a message into sentences. Fenced code and quoted lines are dropped: they are not the agent
 * speaking.
 */
export function sentences(text: string): string[] {
	const out: string[] = [];
	let fenced = false;

	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;

			continue;
		}

		if (fenced || line.trimStart().startsWith(">")) {
			continue;
		}

		for (const part of line.split(/(?<=[.!?])\s+(?=["'(\p{Lu}\d])/u)) {
			const s = part.replaceAll(/\s+/gu, " ").trim();

			if (s.length > 1) {
				out.push(s);
			}
		}
	}

	return out;
}

/** The kind of promise one sentence carries, or undefined. */
export function classify(sentence: string): PromiseKind | undefined {
	if (sentence.endsWith("?") || CONDITIONAL.test(sentence) || RULE.test(sentence)) {
		return undefined;
	}

	if (FUTURE.test(sentence)) {
		return "future";
	}

	if (DELIVERY.test(sentence)) {
		return "delivery";
	}

	return WORKING.test(sentence) ? "working" : undefined;
}

/**
 * True when a sentence talks about later or ongoing work at all, conditional or not. The closer
 * skips these.
 */
export function mentionsLater(sentence: string): boolean {
	return FUTURE.test(sentence) || DELIVERY.test(sentence) || WORKING.test(sentence);
}

/** Every promise-carrying sentence in a message, in order. */
export function detect(text: string): Detected[] {
	const found: Detected[] = [];

	for (const sentence of sentences(text)) {
		const kind = classify(sentence);

		if (kind) {
			found.push({ sentence, kind });
		}
	}

	return found;
}
