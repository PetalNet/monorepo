import { createHash } from "node:crypto";

import { candidateSpans, scanBatch } from "./secrets.ts";

export interface RedactedMessage {
	id: string;
	text: string | null;
	rules: string[];
}

export interface RedactBatchResult {
	messages: RedactedMessage[];
	newHashes: { hash: string; rule: string }[];
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function maskAll(text: string, value: string, rule: string): string {
	return text.split(value).join(`[REDACTED:${rule}]`);
}

/**
 * Value-scoped, fail-closed redaction over one batch.
 *
 * Pass 1 runs the secret scanner over every message in the batch and collects every DISTINCT secret
 * value found anywhere in the batch, plus any value matching a previously-known secret hash found
 * via a generic candidate-substring scan matched against the persisted hash set. The candidate pass
 * is what lets a secret found in an earlier batch get masked here even when this occurrence's
 * surrounding context doesn't match any rule on its own -- we never persist the plaintext value,
 * only its hash, so matching works by hashing each candidate substring and checking it against the
 * known-hash set rather than by remembering the value itself.
 *
 * Pass 2 masks every occurrence of every collected value in EVERY message of the batch, not just
 * the message(s) the scanner originally flagged. This is the value-scoped behavior the brief
 * requires: finding-scoped redaction (masking only the exact message/span a finding came from) lets
 * the same secret value recur unmasked in a sibling message -- the bug the Part C spike found (plan
 * /plan/971 comment #58).
 *
 * A message whose own finding has no usable value (empty/degenerate match) is dropped outright
 * rather than inserted with a guessed mask.
 */
export function redactBatch(
	messages: { id: string; text: string }[],
	knownHashes: ReadonlySet<string>,
): RedactBatchResult {
	const findingsByMessage = scanBatch(messages);
	const valueRules = new Map<string, string>();
	const unmaskable = new Set<string>();

	for (const message of messages) {
		for (const finding of findingsByMessage.get(message.id) ?? []) {
			if (!finding.value || finding.value.trim().length === 0) {
				unmaskable.add(message.id);

				continue;
			}

			if (!valueRules.has(finding.value)) {
				valueRules.set(finding.value, finding.rule);
			}
		}
	}

	if (knownHashes.size > 0) {
		for (const message of messages) {
			if (unmaskable.has(message.id)) {
				continue;
			}

			const { spans, truncated } = candidateSpans(message.text);

			if (truncated) {
				// Fail closed: this message's candidate coverage against the known-secret
				// hash set could not be guaranteed complete, so it cannot be confirmed
				// free of a previously-seen secret (pullfrog's review on PR 535, round 2).
				unmaskable.add(message.id);

				continue;
			}

			for (const value of spans) {
				if (!valueRules.has(value) && knownHashes.has(sha256Hex(value))) {
					valueRules.set(value, "known-value");
				}
			}
		}
	}

	// Longest values first so a shorter value that happens to be a substring
	// of a longer one never gets masked out from inside an already-masked span.
	const orderedValues = [...valueRules.entries()].toSorted((a, b) => b[0].length - a[0].length);

	const results: RedactedMessage[] = messages.map((message) => {
		if (unmaskable.has(message.id)) {
			return { id: message.id, text: null, rules: [] };
		}

		let text = message.text;
		const rulesApplied = new Set<string>();

		for (const [value, rule] of orderedValues) {
			if (text.includes(value)) {
				text = maskAll(text, value, rule);
				rulesApplied.add(rule);
			}
		}

		return { id: message.id, text, rules: [...rulesApplied] };
	});

	const newHashes = orderedValues.map(([value, rule]) => ({ hash: sha256Hex(value), rule }));

	return { messages: results, newHashes };
}
