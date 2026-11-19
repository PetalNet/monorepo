// PreToolUse guard for hermes-link send_message: a Matrix reader cannot open a file on Janet's box, so a message
// that points at one (/home/agent/..., ~/.claude/..., /tmp/..., /run/user/..., /nix/store/...) is useless to them.
// Denies and names the fix: put the content in the message (short), or link a GitHub URL. send_file is named only for
// images, audio and video: Eli's phone opens a .txt attachment in Gallery and he will not read it.
//
// Flagged: an absolute path under /home, /tmp, /var/tmp, /run/user or /nix/store, a ~/ or $HOME/ path.
// Passes (deliberately):
//   - repo-relative names (modules/home/x.nix, src/tmp/a.ts, ./scripts/run.sh) and URLs: the path regex only
//     starts at a boundary, so a root segment inside a longer path or URL never matches;
//   - host-qualified paths (.14:/srv/x, nas:~/x, 10.10.10.12:/mnt/x): scp-style, the person SSHes there;
//   - NAS paths under /services/ and /mnt/, and /etc, /var/log: shared infrastructure Eli and Parker reach by
//     mount or SSH, and system files named as a topic, not local scratch that only Janet's VM holds;
//   - /Users/... and C:\...: a Mac or PC path is named to the person who owns that machine;
//   - paths inside ``` fences that quote a log, diff or command; a fence holding only a path still counts.
// Fails open on bad input.
//
// One file with no dependencies, so Node runs it straight from the source tree: `node matrix-local-path-guard.ts < payload.json`.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOOL = "mcp__hermes-link__send_message";
// The lookbehind rejects a root that continues a longer token: word chars, `.`, `/`, `-` (relative or URL paths),
// `:` (host:/path), `~` and `$`.
const LOCAL =
	/(?<![A-Za-z0-9./:~$-])(?:\/(?:home|root|tmp|run\/user|nix\/store|var\/tmp|dev\/shm)\/[^\s"'`)\]>,;<*]+|(?:~|\$HOME|\$\{HOME\})\/[^\s"'`)\]>,;<*]*[^\s"'`)\]>,;<*.])/u;
const FIX =
	"Eli and Parker cannot open files on Janet's box, and a .txt attachment does not get read either. Put the relevant content inline in the message (keep it short), or link a GitHub URL (a repo file, PR or gist). mcp__hermes-link__send_file is fine only for images, audio and video.";

/** The first local path the message points at, or `null` when it may be sent. */
export function localPath(text: string): string | null {
	// A fence that holds only a path is a pointer in a box, not a quotation.
	const prose = text
		.replace(/(?<![A-Za-z0-9])file:\/\/(?=\/)/gu, "")
		.replace(/```[\s\S]*?```/gu, (fence) =>
			/^```[^\n]*\n\s*\S+\s*```$/u.test(fence) ? fence : "",
		);
	const match = LOCAL.exec(prose);

	return match === null ? null : match[0].replace(/[.:!?_]+$/u, "");
}

interface HookInput {
	readonly tool_name?: unknown;
	readonly tool_input?: { readonly text?: unknown };
}

/** Why a message is denied, or `null` when it may pass. */
export function verdict(input: HookInput | null): string | null {
	const text = input?.tool_input?.text;

	if (input?.tool_name !== TOOL || typeof text !== "string") {
		return null;
	}

	return localPath(text);
}

function denial(path: string) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `BLOCKED: this Matrix message points at a local path (${path}). ${FIX}`,
		},
	};
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

	const path = verdict(input);

	if (path !== null) {
		process.stdout.write(JSON.stringify(denial(path)));
	}

	process.exit(0);
}
