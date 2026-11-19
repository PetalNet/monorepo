// PreToolUse guard for mcp__hermes-link__send_message and send_file: no secrets in Matrix (standing rule).
// Scans the message text / file caption for common token shapes. The deny reason never echoes the match.
// Tuned for few false positives: bare prefixes ("ghp_ tokens") pass; "sk-" and long values next to a key word
// must look random (mixed letters and digits); event ids ($...), mxc:// and http(s) URLs pass. Fails open.
//
// One file with no dependencies: `node matrix-secret-guard.ts < payload.json`.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const mixed = (s: string) => /\d/u.test(s) && /[A-Za-z]/u.test(s);
const PATTERNS: [string, RegExp, (m: RegExpExecArray) => boolean][] = [
	["GitHub token", /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/u, () => true],
	["GitHub fine-grained token", /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/u, () => true],
	["sk- API key", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/u, (m) => mixed(m[0])],
	["Slack token", /(?<![A-Za-z0-9])xox[abeprs]-[A-Za-z0-9-]{10,}/u, () => true],
	["AWS access key id", /(?<![A-Za-z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/u, () => true],
	[
		"JWT",
		/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
		() => true,
	],
	["PEM block", /-----BEGIN [A-Z ]*-----/u, (m) => !/PUBLIC KEY|CERTIFICATE/u.test(m[0])],
	["Matrix access token", /(?<![A-Za-z0-9])syt_[A-Za-z0-9_-]{20,}/u, () => true],
	["Bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{30,}=*/iu, (m) => mixed(m[0])],
	[
		"long value next to a key/token/secret/password word",
		/(?<![A-Za-z])(?:api[_ -]?key|access[_ -]?key|secret|token|passw(?:or)?d|passwd|credential|private[_ -]?key|key)s?["'`]?\s{0,2}(?:[:=]|\bis\b)\s{0,2}["'`]?([A-Za-z0-9+/_=-]{32,})/iu,
		(m) => !/^(\$|mxc:|https?:)/u.test(m[1] ?? "") && mixed(m[1] ?? ""),
	],
];
const SECRET_FILE =
	/(^|\/)(github-pat|[^/]*(token|secret|credential)[^/]*|id_[a-z0-9]+|[^/]*\.(pem|key)|\.env[^/]*)$/iu;

interface HookInput {
	readonly tool_name?: unknown;
	readonly tool_input?: Record<string, unknown> | null;
}

// Every string the call would put in a room: send_message text, send_file caption, raw content/body (any depth), poll question and answers.
function strings(v: unknown, out: string[] = []): string[] {
	if (typeof v === "string") {
		out.push(v);
	} else if (v !== null && typeof v === "object") {
		for (const x of Object.values(v)) {
			strings(x, out);
		}
	}

	return out;
}

/** Why a call is denied, or `null` when it may pass. */
export function verdict(input: HookInput | null): string | null {
	const t = input?.tool_input ?? {};
	const path = t["path"];

	if (typeof path === "string" && SECRET_FILE.test(path)) {
		return "BLOCKED: send_file path looks like a credential file. Standing rule: never send secrets in Matrix. Fix: send a redacted copy, or hand the credential over with the secret-drop tool / janet vault.";
	}

	const text = strings([
		t["text"],
		t["caption"],
		t["content"],
		t["body"],
		t["question"],
		t["answers"],
	]).join("\n");

	for (const [name, re, ok] of PATTERNS) {
		const m = re.exec(text);

		if (m && ok(m)) {
			return (
				`BLOCKED: this Matrix message looks like it contains a secret (${name}). Standing rule: never paste secrets in Matrix. ` +
				`Fix: remove or redact the value (say which vault entry or file holds it, e.g. "in ~/.claude/shared/github-pat") and resend; ` +
				`to hand someone a credential use the secret-drop tool / janet vault, not chat. If this is a false positive, rephrase so the value is not shown.`
			);
		}
	}

	return null;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	let input: HookInput | null;

	try {
		input = JSON.parse(readFileSync(0, "utf8")) as HookInput | null;
	} catch {
		process.exit(0);
	}

	const why = verdict(input);

	if (why !== null) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: why,
				},
			}),
		);
	}

	process.exit(0);
}
