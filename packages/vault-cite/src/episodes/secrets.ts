import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SecretFinding } from "./model.ts";

/**
 * Built-in secret-shape rules, used when the `gitleaks` binary is not on PATH. These cover the
 * common token shapes gitleaks itself ships rules for:
 *
 * - Aws-access-key-id: AWS access key IDs (AKIA...)
 * - Github-pat: GitHub personal/app/oauth/refresh tokens (gh[pousr]_...)
 * - Slack-token: Slack bot/user/app tokens (xox[baprs]-...)
 * - Jwt: three-segment base64url JSON Web Tokens (eyJ...)
 * - Private-key-block: PEM private key blocks
 * - Generic-api-key: a key/secret/token/password assignment followed by a long opaque value (mirrors
 *   gitleaks' generic-api-key rule) Each rule's capture is the SECRET VALUE ONLY, never the
 *   surrounding key/label text, so masking never destroys non-secret context.
 */
const BUILTIN_RULES: { rule: string; re: RegExp; group: number }[] = [
	{ rule: "aws-access-key-id", re: /\b(AKIA[0-9A-Z]{16})\b/g, group: 1 },
	{ rule: "github-pat", re: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g, group: 1 },
	{ rule: "slack-token", re: /\b(xox[baprs]-[A-Za-z0-9-]{10,72})\b/g, group: 1 },
	{
		rule: "jwt",
		re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
		group: 1,
	},
	{
		rule: "private-key-block",
		re: /(-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----)/g,
		group: 1,
	},
	{
		rule: "generic-api-key",
		re: /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*["']?([A-Za-z0-9_\-/+]{16,})["']?/gi,
		group: 1,
	},
];

/**
 * Candidate generation for the persisted known-hash passes (cross-batch masking during ingest, and
 * the end-of-run sweep). A candidate must be a strict SUPERSET of every value a BUILTIN_RULE (or
 * gitleaks) can produce, in both length and character set, or a known secret can stay unmasked
 * wherever a recurrence doesn't carry the original rule's triggering context -- this is a real gap
 * pullfrog's review found in the first slice:
 *
 * - `generic-api-key`'s floor is 16 and `slack-token`'s is 15 (3 + 1 + "-" + 10 minimum); SPAN_FLOOR
 *   here (15) must stay at or below the smallest floor any rule accepts.
 * - `jwt` values contain "." between segments. The character class here includes "." so a full dotted
 *   JWT is produced as ONE candidate, not three dot-split fragments.
 * - "/", "+", "-" are both in-alphabet AND common surrounding punctuation (a URL path separator, a
 *   flag, a hyphenated word). A maximal run greedily swallows them, which would change the hash of
 *   an otherwise-exact-match value. For every such weak delimiter inside a maximal run, this also
 *   yields the sub-spans on either side of it, so a value immediately preceded or followed by one
 *   of these characters is still produced byte-for-byte as its own candidate.
 */
const WIDE_RUN_RE = /[A-Za-z0-9_\-/+.]{15,}/g;
const WEAK_DELIMITER_RE = /[.\-/+]/;
const SPAN_FLOOR = 15;
const MAX_BOUNDARY_POINTS = 48;

export interface CandidateResult {
	spans: string[];
	/**
	 * True when at least one run had more weak-delimiter boundary points than this module is willing
	 * to enumerate pairwise. Earlier code sampled boundaries in that case, which is UNSOUND: if the
	 * known value itself contains one of these delimiters (e.g. "D"x18 + "-" + "E"x18), the specific
	 * boundary pair that reconstructs it byte-for-byte might not survive sampling, so a known secret
	 * could stay unmasked and still pass verification (pullfrog's review on PR 535, round 2). Callers
	 * MUST treat `truncated: true` as "this text's coverage cannot be guaranteed" and fail closed
	 * (quarantine/drop), never as "no match found."
	 */
	truncated: boolean;
}

export function candidateSpans(text: string): CandidateResult {
	const spans: string[] = [];
	let truncated = false;

	for (const match of text.matchAll(WIDE_RUN_RE)) {
		const run = match[0];

		spans.push(run);

		const boundarySet = new Set<number>([0, run.length]);

		for (let i = 0; i < run.length; i++) {
			if (WEAK_DELIMITER_RE.test(run[i] ?? "")) {
				boundarySet.add(i);
				boundarySet.add(i + 1);
			}
		}

		const boundaries = [...boundarySet].toSorted((a, b) => a - b);

		if (boundaries.length > MAX_BOUNDARY_POINTS) {
			truncated = true;

			continue;
		}

		for (const [i, start] of boundaries.entries()) {
			for (const end of boundaries.slice(i + 1)) {
				if (end - start >= SPAN_FLOOR && end - start < run.length) {
					spans.push(run.slice(start, end));
				}
			}
		}
	}

	return { spans, truncated };
}

function builtinScan(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];

	for (const { rule, re, group } of BUILTIN_RULES) {
		for (const match of text.matchAll(re)) {
			const value = match[group];

			if (value && value.length >= 3) {
				findings.push({ value, rule });
			}
		}
	}

	return findings;
}

function gitleaksAvailable(): boolean {
	return spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;
}

interface GitleaksReportRow {
	Secret: string;
	RuleID: string;
	File: string;
}

/**
 * Scans a batch of messages, each attributed to the message that produced it with no line-offset
 * arithmetic: when gitleaks is available each message is written to its OWN file inside a scratch
 * directory and gitleaks scans that directory once per batch, so a finding's `File` field (the
 * message id) IS the attribution -- there is no running byte/line offset to drift. This is the fix
 * for the spike's line-offset drift bug (plan /plan/971 comment #58): that bug came from
 * attributing findings back to messages via an incrementally-tracked offset, which could accumulate
 * error across a batch.
 */
export function scanBatch(messages: { id: string; text: string }[]): Map<string, SecretFinding[]> {
	const result = new Map<string, SecretFinding[]>();

	for (const message of messages) {
		result.set(message.id, builtinScan(message.text));
	}

	if (messages.length === 0 || !gitleaksAvailable()) {
		return result;
	}

	const dir = mkdtempSync(path.join(os.tmpdir(), "vault-episodes-gitleaks-"));

	try {
		for (const message of messages) {
			writeFileSync(path.join(dir, `${encodeURIComponent(message.id)}.txt`), message.text);
		}

		const reportPath = path.join(dir, "__report.json");
		const run = spawnSync(
			"gitleaks",
			[
				"detect",
				"--no-git",
				"--no-banner",
				"--source",
				dir,
				"--report-format",
				"json",
				"--report-path",
				reportPath,
				"--exit-code",
				"0",
			],
			{ encoding: "utf8" },
		);

		if (run.status !== 0 || run.error) {
			// gitleaks itself failed to run; fall back to the built-in rules only
			// for this batch rather than trust a scan that may not have completed.
			return result;
		}

		let rows: GitleaksReportRow[] = [];

		try {
			const raw = readFileSync(reportPath, "utf8").trim();

			rows = raw ? (JSON.parse(raw) as GitleaksReportRow[]) : [];
		} catch {
			return result;
		}

		for (const row of rows) {
			const fileName = path.basename(row.File);
			const id = decodeURIComponent(fileName.replace(/\.txt$/, ""));
			const existing = result.get(id) ?? [];

			if (row.Secret && row.Secret.length >= 3) {
				existing.push({ value: row.Secret, rule: row.RuleID });
			}

			result.set(id, existing);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	return result;
}
