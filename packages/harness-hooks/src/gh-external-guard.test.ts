import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verdict } from "./gh-external-guard.ts";

const FORK_RULE = /fork/u;
const NO_REPO = /--repo/u;

// Invented repos: `outsider/*` is a third party, `PetalNet/*` is on the allowlist.
const DENIED: [string, string, RegExp][] = [
	["external PR via --repo", "gh pr create --repo outsider/lib --title x", FORK_RULE],
	["PR with no --repo", "gh pr create --title x", NO_REPO],
	["issue with no --repo", "gh issue create -t x", NO_REPO],
	[
		"external issue via --repo",
		"gh issue create --repo outsider/lib --title x --body y",
		/fork|human/iu,
	],
	["external issue via -R", "gh issue create -R outsider/lib -t x", FORK_RULE],
	["external PR via -R", "gh pr create -R outsider/lib -t x", FORK_RULE],
	["reopen is covered too", "gh pr reopen 4 --repo outsider/lib", FORK_RULE],
	["api pulls with a field", "gh api repos/outsider/lib/pulls -f title=x", FORK_RULE],
	["api issues with a field", "gh api repos/outsider/lib/issues -f title=x", FORK_RULE],
	[
		"api issues with -X POST",
		"gh api -X POST repos/outsider/lib/issues --input body.json",
		FORK_RULE,
	],
	["a line-continued gh api", "gh api \\\n  repos/outsider/lib/pulls -f title=a", FORK_RULE],
	[
		"graphql create mutation",
		"gh api graphql -f query='mutation{createIssue(input:{})}'",
		/GraphQL/u,
	],
	[
		"curl --json to the issues API",
		"curl --json {} https://api.github.com/repos/outsider/lib/issues",
		FORK_RULE,
	],
	["a quoted -R is not the repo flag", 'gh pr create --body "cc -R PetalNet/x"', NO_REPO],
	["a quoted --repo is not the repo flag", 'gh pr create --title "see --repo PetalNet/x"', NO_REPO],
	[
		"second command in a && chain",
		"gh pr create -R PetalNet/x && gh pr create -R outsider/lib",
		/outsider/u,
	],
	[
		"second command after ;",
		"gh pr create -R PetalNet/x; gh issue create -R outsider/lib -t y",
		/outsider/u,
	],
	["end of a pipe", "echo hi | gh pr create -R outsider/lib", FORK_RULE],
	["bash -c string", 'bash -c "gh pr create --repo outsider/lib"', /outsider/u],
	["command substitution", "x=$(gh pr create --repo outsider/lib)", /outsider/u],
	["GH_REPO assignment", "GH_REPO=outsider/lib gh pr create --title t", /outsider/u],
	["gh after a heredoc", "cat <<'EOF'\nhi\nEOF\ngh pr create --repo outsider/lib", /outsider/u],
	[
		"gh after an apostrophe heredoc inside $( )",
		"git commit -m \"$(cat <<'EOF'\nit's fine\nEOF\n)\"\ngh pr create --repo outsider/lib",
		/outsider/u,
	],
	[
		"unquoted heredoc runs $( )",
		"cat <<EOF\n$(gh pr create --repo outsider/lib)\nEOF",
		/outsider/u,
	],
	[
		"after a here-string with a quote",
		'cat <<<"a b"; gh pr create --repo outsider/lib',
		/outsider/u,
	],
	["after a bare here-string", "cat <<<x\ngh pr create --repo outsider/lib", /outsider/u],
	["if keyword", "if true; then gh pr create --repo outsider/lib; fi", /outsider/u],
	["bang keyword", "! gh pr create --repo outsider/lib", /outsider/u],
	["sudo with options", "sudo -u bob gh pr create --repo outsider/lib", /outsider/u],
	["env with options", "env -i gh pr create --repo outsider/lib", /outsider/u],
	["timeout", "timeout 10 gh pr create --repo outsider/lib", /outsider/u],
	["nice", "nice -n 5 gh pr create --repo outsider/lib", /outsider/u],
	["time", "time -p gh pr create --repo outsider/lib", /outsider/u],
	["xargs", "xargs gh pr create --repo outsider/lib", /outsider/u],
	["ssh script string", "ssh box 'gh pr create --repo outsider/lib'", /outsider/u],
	["eval string", "eval 'gh pr create --repo outsider/lib'", /outsider/u],
	["bash -lc string", "bash -lc 'gh pr create --repo outsider/lib'", /outsider/u],
	["for loop body", "for i in 1; do gh pr create --repo outsider/lib; done", /outsider/u],
	["the last --repo wins", "gh pr create --repo PetalNet/x --repo outsider/y", /outsider/u],
	["flags before the verb", "gh pr -R outsider/lib create", /outsider/u],
	["attached -X and -f", "gh api repos/outsider/lib/issues -XPOST -ftitle=t", FORK_RULE],
	["full API URL", "gh api https://api.github.com/repos/outsider/lib/issues -f title=t", FORK_RULE],
	["endpoint with a query string", "gh api repos/outsider/lib/issues?a=1 -f title=t", FORK_RULE],
	["curl with -XPOST", "curl -XPOST https://api.github.com/repos/outsider/lib/issues", FORK_RULE],
	["curl with -d@file", "curl -d@f https://API.GITHUB.COM/repos/outsider/lib/issues", FORK_RULE],
	["ANSI-C quoted word", "gh $'pr' create --repo outsider/lib", /outsider/u],
	[
		"absurd nesting that mentions gh fails closed",
		`echo ${"$(".repeat(3000)}${")".repeat(3000)}; gh pr create --repo outsider/lib`,
		/could not be parsed/u,
	],
];

const PASSED: [string, string][] = [
	["lab PR", "gh pr create --repo PetalNet/tools --title x"],
	["lab owner is case-insensitive", "gh pr create --repo PETALNET/tools --title x"],
	["lab PR via -R", "gh pr create -R PetalNet/monorepo -t x"],
	["lab issue", "gh issue create --repo PetalNet/tools --title x"],
	["lab issue via -R", "gh issue create -R PetalNet/tools -t x"],
	["unrelated command", "git status"],
	["reading an external issue", "gh issue view 12 --repo outsider/lib"],
	["listing external issues", "gh issue list --repo outsider/lib"],
	["api read of an issue", "gh api repos/outsider/lib/issues/12"],
	["api issue write on a lab repo", "gh api repos/PetalNet/x/issues -f title=x"],
	["curl read", "curl -X GET https://api.github.com/repos/outsider/lib/issues"],
	[
		"--repo= attached with a quoted -R body",
		'gh pr create --repo=PetalNet/x --body "-R outsider/x"',
	],
	["single-quoted --repo in a body", "gh pr create -R PetalNet/x --body 'fixes --repo outsider/x'"],
	[
		"both commands in a chain are lab repos",
		"gh pr create -R PetalNet/x && gh issue create -R PetalNet/y -t y",
	],
	["gh in a commit message", 'git commit -m "docs: mention gh issue create"'],
	["gh in an echoed string", 'echo "gh pr create --repo outsider/lib"'],
	[
		"gh in a quoted heredoc",
		"git commit -F - <<'EOF'\nfix: guard gh issue create\n\ngh pr create --repo outsider/lib\nEOF",
	],
	[
		"gh in a quoted heredoc inside $( )",
		"git commit -m \"$(cat <<'EOF'\nit's fine, gh pr create --repo outsider/lib\nEOF\n)\"",
	],
	["quoted heredoc with $( )", "cat <<'EOF'\n$(gh pr create --repo outsider/lib)\nEOF"],
	["flags before the verb, lab repo", "gh pr -R PetalNet/x create --title t"],
	["absurd nesting without gh fails open", `echo ${"$(".repeat(3000)}${")".repeat(3000)}`],
];

describe("gh-external-guard verdict", () => {
	it.each(DENIED)("denies %s", (_name, command, reason) => {
		expect(verdict(command)).toMatch(/^BLOCKED/u);
		expect(verdict(command)).toMatch(reason);
	});

	it.each(PASSED)("passes %s", (_name, command) => {
		expect(verdict(command)).toBeNull();
	});

	it("passes an empty command", () => {
		expect(verdict("")).toBeNull();
	});
});

describe("gh-external-guard as a hook process", () => {
	const script = fileURLToPath(new URL("gh-external-guard.ts", import.meta.url));
	const run = (stdin: string) => {
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			input: stdin,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);

		return result.stdout;
	};

	const bash = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

	it("prints a deny that names the fork rule", () => {
		const out = JSON.parse(run(bash("gh pr create --repo outsider/lib --title x"))) as {
			hookSpecificOutput: {
				hookEventName: string;
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};

		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("push your branch to a fork");
	});

	it("prints nothing for a lab repo", () => {
		expect(run(bash("gh pr create --repo PetalNet/tools --title x"))).toBe("");
	});

	it("fails open on bad input and on a missing command", () => {
		expect(run("not json")).toBe("");
		expect(run(JSON.stringify({ tool_name: "Bash", tool_input: {} }))).toBe("");
		expect(run("null")).toBe("");
	});
});
