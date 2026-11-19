// The automatic closer: does a later outgoing message in the same room clearly deliver an open promise?
// A false close is a silent drop, so this errs toward leaving a promise open: an unclosed promise only costs a
// reminder. A message closes a promise when one of its sentences (a) says nothing about later, and is not a question,
// (b) plainly reports finished work or hands something over, with no negation or condition, and (c) names at least
// three of the same specific things as the promising sentence.
import { mentionsLater, sentences } from "./promise-detect.ts";

const STOP = new Set(
	`about above after again against also another around because been before being below between both could does doing
done down during each every from further have having here hers into itself just like more most much only other over
same should some such than that their theirs them then there these they this those through under until very want were
what when where which while will with would your yours ours once soon still next first later today tonight tomorrow
now send sent sending check checked checking tell told ping post posted link links back come comes coming goes going
make made making take takes taking give gives look looking need needs know thing things stuff something anything
everything also well right away live ready sure need able it'll i'll you'll we'll they'll that'll gets getting
really actually already whether myself yourself answer result results update updates list short full real true
message messages moment minute minutes hour hours time times work works working part parts side kind`.split(
		/\s+/u,
	),
);

/**
 * The specific words of a text: lowercased, stop words and short words dropped, plural and verb
 * endings folded.
 */
export function keywords(text: string): Set<string> {
	const out = new Set<string>();

	for (const raw of text
		.toLowerCase()
		.match(/[\p{L}\p{N}][\p{L}\p{N}'’.#/-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? []) {
		// "it's" and "page's" are "it" and "page".
		const word = raw.replaceAll("\u2019", "'").replace(/'(?:s|ll|re|ve|d|m|t)$/u, "");

		if (STOP.has(word)) {
			continue;
		}

		// A number, version or issue reference is specific at any length; a word needs four letters.
		if (/\d/u.test(word)) {
			if (word.length >= 2) {
				out.add(word);
			}

			continue;
		}

		if (word.length < 4) {
			continue;
		}

		const stem = word.replace(/(?:ing|ed|es|s)$/u, "");

		if (stem.length >= 3 && !STOP.has(stem)) {
			out.add(stem);
		}
	}

	return out;
}

const DONE_VERB =
	"sent|posted|merged|deployed|fixed|added|checked|ran|run|built|moved|switched|restarted|measured|tested|filed|submitted|put|made|wrote|written|drafted|found|pulled|pushed|asked|told|uploaded|updated|finished|set|created|removed|cleaned|confirmed|verified|installed|published|shipped|scheduled|booked|cancelled|canceled|reviewed|compared|mirrored|read|looked|picked|replaced|restored|cleared|closed|opened|saved|logged";
const DONE_STATE =
	"live|up|merged|deployed|done|fixed|sent|posted|ready|in|out|shipped|installed|published|running|back|built|finished|complete|attached|green|on|off|gone|open|closed|added|updated|switched over|set up";

// A sentence that says something finished or hands something over, in a form that is hard to say by accident.
const FINISHED = new RegExp(
	[
		String.raw`^(?:done|fixed|merged|sent|deployed|shipped|posted|added|updated|found|checked|verified|confirmed|installed|submitted|finished|live|here)\b`,
		String.raw`\b(?:is|are|it's|it\u2019s|that's|that\u2019s|they're|they\u2019re) (?:now |all |both |already |fully )?(?:${DONE_STATE})\b`,
		String.raw`\bI(?:'ve|\u2019ve| have)? (?:now |just |already |also )?(?:${DONE_VERB})\b`,
		String.raw`\bhere(?:'s|\u2019s| is| are)\b`,
	].join("|"),
	"iu",
);

// Anything that makes the sentence less than a plain report of finished work: negation, a condition, more to come.
const HEDGED =
	/\b(?:not|nothing|none|never|no|but|except|until|unless|still|yet|if|will|once|before|should|would|could|may|might|can|gets?|needs?|wants?|waiting|blocked|stuck|failed|failing|so far|partly|half|almost|trying|next|then|after|when)\b|n['\u2019]t\b/iu;

/** The sentence in `later` that delivers `promise`, or undefined. */
export function delivers(promise: string, later: string, minShared = 3): string | undefined {
	// "once the fix is merged" names what the promise waits for, not what it delivers: a report that the fix merged
	// must not close "I'll send the numbers once the fix is merged".
	const own = keywords(
		promise.replaceAll(/\b(?:once|after|when|until|as soon as|before|if|while)\b[^,.;!?]*/giu, " "),
	);

	for (const sentence of sentences(later)) {
		if (
			sentence.endsWith("?") ||
			mentionsLater(sentence) ||
			!FINISHED.test(sentence) ||
			HEDGED.test(sentence)
		) {
			continue;
		}

		let shared = 0;

		for (const word of keywords(sentence)) {
			if (own.has(word)) {
				shared += 1;
			}
		}

		if (shared >= minShared) {
			return sentence;
		}
	}

	return undefined;
}
