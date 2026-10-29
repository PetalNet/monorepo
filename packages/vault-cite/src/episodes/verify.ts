import { sha256Hex } from "./redact.ts";
import { scanBatch } from "./secrets.ts";
import type { EpisodeStore } from "./store.ts";

export interface VerifyResult {
	scanned: number;
	hits: number;
	hitEpisodeIds: string[];
}

/**
 * Independent-of-redaction candidate generation. This is deliberately NOT the same code as
 * `candidateSpans` in secrets.ts (the one `redactBatch` and `sweepResidualSecrets` use):
 * verification is the project's safety net, so it must not inherit a blind spot from the same
 * matcher it exists to audit (pullfrog's review on the first slice found exactly this failure mode
 * -- a narrower shared matcher let a known secret stay searchable while verify reported zero hits).
 * Same semantic goal as candidateSpans (every contiguous sub-span of a wide run, split at weak
 * delimiters, down to a floor below every BUILTIN_RULE's minimum), reached by splitting into
 * alternating [fragment, delimiter, fragment, ...] pieces instead of boundary index arithmetic.
 */
const WIDE_RUN_RE = /[A-Za-z0-9_\-/+.]{15,}/g;
const WEAK_DELIMITER_RE = /([.\-/+])/;
const FLOOR = 15;
const MAX_PIECES = 97; // ~48 delimiters before falling back to whole-run + single fragments only

interface IndependentCandidateResult {
	spans: string[];
	/**
	 * True when at least one run had more delimiter-bounded pieces than this function is willing to
	 * enumerate pairwise. Earlier code fell back to whole-run + single-fragment candidates in that
	 * case, which is UNSOUND when the known value itself spans multiple fragments (contains one of
	 * its own delimiters) -- it would never be reconstructed from single fragments or the (much
	 * longer, differently-hashing) whole run. Callers MUST treat `truncated: true` as a verification
	 * HIT, not as "no match found" (pullfrog's review on PR 535, round 2).
	 */
	truncated: boolean;
}

function independentCandidates(text: string): IndependentCandidateResult {
	const spans: string[] = [];
	let truncated = false;

	for (const match of text.matchAll(WIDE_RUN_RE)) {
		const run = match[0];

		spans.push(run);

		const pieces = run.split(WEAK_DELIMITER_RE);

		if (pieces.length > MAX_PIECES) {
			truncated = true;

			continue;
		}

		for (let start = 0; start < pieces.length; start += 2) {
			let candidate = "";

			for (let end = start; end < pieces.length; end++) {
				candidate += pieces[end] ?? "";

				if (end % 2 === 0 && candidate.length >= FLOOR && candidate.length < run.length) {
					spans.push(candidate);
				}
			}
		}
	}

	return { spans, truncated };
}

/**
 * Post-ingest verification, with two independent checks:
 *
 * 1. Re-runs the SAME rule-based detectors ingest uses (gitleaks or the built-in rules) directly
 *    against the indexed text. This catches any secret-shaped text regardless of whether its
 *    value's hash was ever recorded -- a new shape, or a gap anywhere else in the pipeline.
 * 2. Independent candidate-hash matching against the persisted known-secret hash set, using this
 *    module's own span generator rather than the ingest side's, so a bug in the ingest matcher
 *    can't also blind verification to the same gap.
 *
 * A hit from either check means a raw secret value made it into the FTS index despite redaction.
 * Never logs or returns the matched value itself, only the episode id it was found in.
 */
export function verifyEpisodes(episodes: EpisodeStore): VerifyResult {
	const knownHashes = episodes.knownHashes();
	const hitIds = new Set<string>();
	let scanned = 0;
	let detectorBatch: { id: string; text: string }[] = [];

	const flushDetectorBatch = () => {
		if (detectorBatch.length === 0) {
			return;
		}

		const findings = scanBatch(detectorBatch);

		for (const { id } of detectorBatch) {
			if ((findings.get(id) ?? []).length > 0) {
				hitIds.add(id);
			}
		}

		detectorBatch = [];
	};

	for (const { id, text } of episodes.allText()) {
		scanned++;
		detectorBatch.push({ id, text });

		if (detectorBatch.length >= 200) {
			flushDetectorBatch();
		}

		if (knownHashes.size > 0) {
			const { spans, truncated } = independentCandidates(text);

			if (truncated) {
				// Fail closed: coverage against the known-secret hash set could not be
				// guaranteed complete for this episode, so it cannot be confirmed clean.
				hitIds.add(id);
			} else {
				for (const candidate of spans) {
					if (knownHashes.has(sha256Hex(candidate))) {
						hitIds.add(id);

						break;
					}
				}
			}
		}
	}

	flushDetectorBatch();

	return { scanned, hits: hitIds.size, hitEpisodeIds: [...hitIds] };
}
