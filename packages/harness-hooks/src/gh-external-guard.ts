// PreToolUse(Bash) guard enforcing push-to-fork-never-open-external-prs.
// DENIES any command that OPENS or REOPENS a pull request OR CREATES an issue against a repo NOT owned by the lab
// (the owners in GH_GUARD_ALLOW_OWNERS, a comma-separated list; default petalnet). Third-party contributions:
// push the branch to a FORK and let a HUMAN open the upstream PR or issue.
// The command is tokenised with shell.ts, so only real `gh`/`curl` invocations count: text inside quotes, heredocs
// (commit messages, PR bodies) never matches, a flag must be a real argv token, and every command in a chain, pipe,
// $( ) or `bash -c "..."` is checked on its own. Covers gh pr create/reopen, gh issue create/reopen, gh api on
// repos/o/r/pulls (any call) and repos/o/r/issues (writes only), gh api graphql create mutations, curl to api.github.com.
// Reading issues is not touched. Fail-open on parse errors.
//
// No dependencies beyond its sibling: `node gh-external-guard.ts < payload.json`.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { splitCommands } from "./shell.ts";

const ALLOW_OWNERS = new Set(
	(process.env["GH_GUARD_ALLOW_OWNERS"] ?? "petalnet")
		.split(",")
		.map((o) => o.trim().toLowerCase())
		.filter((o) => o !== ""),
);

type Env = Readonly<Record<string, string>>;

const external = (what: string, owner: string) =>
	`BLOCKED — opening a ${what} on '${owner}/…' is a THIRD-PARTY repo. Golden rule (push-to-fork-never-open-external-prs): push your branch to a fork and let a HUMAN open the upstream PR or issue; never open one on a repo the lab doesn't own. If this genuinely is a lab repo, add its owner to GH_GUARD_ALLOW_OWNERS — don't work around this.`;
const noRepo = (what: string) =>
	`BLOCKED — 'gh ${what} create/reopen' with no --repo. For a fork this targets the EXTERNAL upstream. Golden rule: push to the fork + a HUMAN opens the upstream PR or issue. If this is a lab repo, re-run with an explicit --repo PetalNet/… (allowlisted).`;

// The repo named by a real --repo/-R flag (the last one wins, as in gh), else by a GH_REPO assignment, else null.
function repoOf(args: readonly string[], env: Env): string | null {
	let repo: string | null = null;

	for (let k = 0; k < args.length; k++) {
		const a = args[k] ?? "";

		if (/\s/u.test(a)) {
			continue; // a flag never contains whitespace; this is a value such as a quoted body
		}

		if (a === "--repo" || a === "-R") {
			repo = args[++k] ?? null;
		} else if (a.startsWith("--repo=")) {
			repo = a.slice(7);
		} else if (/^-R./u.test(a)) {
			repo = a.slice(2).replace(/^=/u, "");
		}
	}

	return repo ?? env["GH_REPO"] ?? null;
}

// [HOST/]OWNER/REPO
const ownerOf = (repo: string | null) =>
	repo?.includes("/") ? (repo.split("/").slice(-2, -1)[0] ?? null) : null;

// Positional words of a gh command line, skipping flags and the value of --repo/-R.
function positionals(args: readonly string[]): string[] {
	const p: string[] = [];

	for (let k = 0; k < args.length; k++) {
		const a = args[k] ?? "";

		if (a === "-R" || a === "--repo") {
			k++;
		} else if (!a.startsWith("-")) {
			p.push(a);
		}
	}

	return p;
}

const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/iu;
// repos/o/r/(pulls|issues) in an endpoint or URL, any case, with a query string allowed.
const endpoint = (a: string) =>
	/^\/?repos\/([^/]+)\/[^/]+\/(pulls|issues)$/iu.exec(
		a.replace(/^https?:\/\/api\.github\.com/iu, "").replace(/\?.*$/u, ""),
	);

const isExternalHit = (m: RegExpExecArray | null, writes: boolean): m is RegExpExecArray =>
	m !== null &&
	((m[2] ?? "").toLowerCase() === "pulls" || writes) &&
	!ALLOW_OWNERS.has((m[1] ?? "").toLowerCase());
const hitReason = (m: RegExpExecArray) =>
	external((m[2] ?? "").toLowerCase() === "pulls" ? "PR" : "issue", m[1] ?? "");

function checkGh(args: readonly string[], env: Env): string | null {
	const [sub, verb] = positionals(args);

	if ((sub === "pr" || sub === "issue") && (verb === "create" || verb === "reopen")) {
		const owner = ownerOf(repoOf(args, env));

		if (!owner) {
			return noRepo(sub);
		}

		if (!ALLOW_OWNERS.has(owner.toLowerCase())) {
			return external(sub === "pr" ? "PR" : "issue", owner);
		}

		return null;
	}

	if (sub === "api") {
		const a = args.slice(args.indexOf("api") + 1);

		if (
			positionals(a)[0] === "graphql" &&
			a.some((x) => /\b(createIssue|createPullRequest)\b/u.test(x))
		) {
			return "BLOCKED — a GraphQL createIssue/createPullRequest mutation cannot be checked for its target repo. Golden rule: push to a fork and let a HUMAN open upstream PRs and issues; for a lab repo use gh pr/issue create --repo PetalNet/….";
		}

		const writes = a.some(
			(x, j) =>
				/^-[fF]./u.test(x) ||
				/^(-f|-F|--field|--raw-field|--input)(=|$)/u.test(x) ||
				(x.startsWith("--method=") && WRITE_METHOD.test(x.slice(9))) ||
				((x === "-X" || x === "--method") && WRITE_METHOD.test(a[j + 1] ?? "")) ||
				(/^-X./u.test(x) && WRITE_METHOD.test(x.slice(2))),
		);

		for (const x of a) {
			const m = endpoint(x);

			if (isExternalHit(m, writes)) {
				return hitReason(m);
			}
		}
	}

	return null;
}

function checkCurl(args: readonly string[]): string | null {
	const writes = args.some(
		(x, j) =>
			/^(--data\S*|--json|-d.*|-F.*|--form)$/u.test(x) ||
			((x === "-X" || x === "--request") && WRITE_METHOD.test(args[j + 1] ?? "")) ||
			(/^-X./u.test(x) && WRITE_METHOD.test(x.slice(2))) ||
			(x.startsWith("--request=") && WRITE_METHOD.test(x.slice(10))),
	);

	for (const x of args) {
		const m = /api\.github\.com\/repos\/([^/\s]+)\/[^/\s]+\/(pulls|issues)\b/iu.exec(x);

		if (isExternalHit(m, writes)) {
			return hitReason(m);
		}
	}

	return null;
}

// Programs that run another command given in their arguments (or, for shells, in a -c string).
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);
const INDIRECT = new Set(
	`env time command exec nohup sudo doas nice timeout stdbuf setsid xargs ssh eval watch su script parallel builtin ionice chroot flock unbuffer bash sh zsh dash`.split(
		" ",
	),
);
const ASSIGNMENT = /^[A-Za-z_]\w*=/u;
const lastSegment = (s: string) => s.split("/").pop() ?? "";

function check(src: string, depth = 0): string | null {
	if (depth > 6) {
		throw new Error("nesting");
	}

	for (const { argv, env } of splitCommands(src)) {
		let a = argv;
		let e: Env = env;

		while (a.length > 0 && (KEYWORDS.has(a[0] ?? "") || ASSIGNMENT.test(a[0] ?? ""))) {
			const first = a[0] ?? "";

			if (ASSIGNMENT.test(first)) {
				const k = first.indexOf("=");

				e = { ...e, [first.slice(0, k)]: first.slice(k + 1) };
			}

			a = a.slice(1);
		}

		if (a.length === 0) {
			continue;
		}

		const prog = lastSegment(a[0] ?? "");
		let why: string | null = null;

		if (prog === "gh") {
			why = checkGh(a.slice(1), e);
		} else if (prog === "curl") {
			why = checkCurl(a.slice(1));
		} else if (INDIRECT.has(prog)) {
			for (let k = 1; k < a.length && why === null; k++) {
				const arg = a[k] ?? "";
				const w = lastSegment(arg);

				if (w === "gh") {
					why = checkGh(a.slice(k + 1), e);
				} else if (w === "curl") {
					why = checkCurl(a.slice(k + 1));
				} else if (/\s/u.test(arg) || /^(bash|sh|eval)$/u.test(w)) {
					why = check(arg, depth + 1); // a script string: bash -lc '...', eval '...', ssh host '...'
				}
			}
		}

		if (why !== null) {
			return why;
		}
	}

	return null;
}

/** Why a shell command is denied, or `null` when it may pass. */
export function verdict(cmd: string): string | null {
	if (!cmd) {
		return null;
	}

	try {
		return check(cmd);
	} catch {
		// Unparsable or absurdly nested: fail closed only when the text can open a PR/issue, else fail open.
		if (/\bgh\b[\s\S]*\b(pr|issue|api)\b|api\.github\.com/u.test(cmd)) {
			return "BLOCKED — this command could not be parsed safely (too deeply nested) and mentions gh/api.github.com. Split it into plain commands with an explicit --repo PetalNet/….";
		}

		return null;
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	let cmd = "";

	try {
		const input = JSON.parse(readFileSync(0, "utf8")) as {
			tool_input?: { command?: unknown } | null;
		} | null;

		const command = input?.tool_input?.command;

		cmd = typeof command === "string" ? command : "";
	} catch {
		process.exit(0);
	}

	const why = verdict(cmd);

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
