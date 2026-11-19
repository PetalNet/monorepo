// PreToolUse guard for Bash, Write and Edit: no public DNS resolvers (standing rule "NEVER 1.1.1.1").
// The lab resolves through its own AdGuard (see dot14-dns-off-adguard); a public resolver in a command or file
// bypasses split-horizon DNS and filtering. Allowed by path: the hook's own repo (janet-nix checkouts) and test
// fixtures, which must name the addresses to test for them. Fails open on any parse error.
//
// One file with no dependencies: `node resolver-guard.ts < payload.json`.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const IP =
	/(?<![\d.])(1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9|149\.112\.112\.112)(?!\.?\d)|(2001:4860:4860::88(?:88|44)|2606:4700:4700::1(?:111|001)|2620:fe::(?:fe|9))|\b(dns\.google|cloudflare-dns\.com|dns\.quad9\.net)\b/iu;
const ALLOWED_PATH = /(^|\/)janet-nix[\w.-]*\/|(^|\/)(tests?|fixtures?|__fixtures__)\//u;
// A network or DNS tool is never exempted by location: the address would really be used.
const NET_TOOL = /\b(dig|nslookup|host|drill|kdig|resolvectl|curl|wget|ping|nc|ssh|telnet)\b/u;
const REPO_CMD =
	/^\s*cd\s+["']?[^\s"';&|]*janet-nix[\w.-]*(\/|["']?\s*(&&|;|$))|\bgit\s+-C\s+["']?[^\s"']*janet-nix[\w.-]*/u;

interface HookInput {
	readonly tool_name?: unknown;
	readonly cwd?: unknown;
	readonly tool_input?: Record<string, unknown> | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Why a call is denied, or `null` when it may pass. */
export function verdict(input: HookInput | null): string | null {
	const t = input?.tool_input ?? {};
	let text: string;
	let allowed: boolean;

	switch (input?.tool_name) {
		case "Bash":
			text = str(t["command"]);

			allowed =
				(ALLOWED_PATH.test(`${str(input.cwd)}/`) || REPO_CMD.test(text)) && !NET_TOOL.test(text);

			break;
		case "Write":
			text = str(t["content"]);
			allowed = ALLOWED_PATH.test(str(t["file_path"]));

			break;
		case "Edit":
			text = str(t["new_string"]);
			allowed = ALLOWED_PATH.test(str(t["file_path"]));

			break;
		default:
			return null;
	}

	const m = IP.exec(text);

	if (!m || allowed) {
		return null;
	}

	const found = m[1] ?? m[2] ?? m[3];

	return (
		`BLOCKED: ${String(found)} is a public DNS resolver. Standing rule: never use public resolvers (NEVER 1.1.1.1). ` +
		`Fix: use the lab's local resolver (the AdGuard instance on .14, see memory dot14-dns-off-adguard) or the system resolver, ` +
		`and drop the address from this ${input.tool_name === "Bash" ? "command" : "content"}. ` +
		`A test or the guard's own repo (a janet-nix checkout) or a test/fixtures path may name it.`
	);
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
