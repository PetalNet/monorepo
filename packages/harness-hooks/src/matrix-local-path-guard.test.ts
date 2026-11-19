import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { localPath, verdict } from "./matrix-local-path-guard.ts";

const send = (text: string, tool_name = "mcp__hermes-link__send_message") => ({
	tool_name,
	tool_input: { room: "!r:example.org", text },
});

// Excerpts of messages Janet really sent to the lab's Matrix rooms (2026-11-18), with the path each one points at.
const DENIED_REAL: [string, string, string][] = [
	[
		"a report pointer",
		"There's also a 2.1 GB db that duplicates recall.db.\n\nFull report: /home/agent/impermanence-inventory-2026-11-18/report.txt",
		"/home/agent/impermanence-inventory-2026-11-18/report.txt",
	],
	[
		"a bare ~/.claude directory",
		"Quick survey of ~/.claude (about 20 GB), biggest problems first: 1. plugins/matrix-channel, 2.4 GB",
		"~/.claude",
	],
	[
		"~/.claude/hooks mid-sentence",
		"25 hook entries, 9 pointing at hand scripts in an un-gitted ~/.claude/hooks, plus 5 hand-registered MCP servers.",
		"~/.claude/hooks",
	],
	[
		"a path in parentheses",
		"I've installed that planning-work skill (~/.claude/skills/planning-work, subagent-only). When a task needs a plan",
		"~/.claude/skills/planning-work",
	],
	[
		"a path ending a sentence",
		"the files the ledger points to are in ~/.claude/shared/ledger-files. I checked the 31 old clones",
		"~/.claude/shared/ledger-files",
	],
	[
		"/tmp scratch",
		"about 13 GB of old session scratch in /tmp/claude-1000. I haven't touched that yet",
		"/tmp/claude-1000",
	],
	[
		"~/.claude.json",
		"2. ~/.claude.json gets replaced by rename, so a bind mount breaks it.",
		"~/.claude.json",
	],
];

const DENIED_SHAPES: [string, string, string][] = [
	["a quoted path", 'saved to "/home/agent/out.txt" for you', "/home/agent/out.txt"],
	["a backticked path", "see `/home/agent/work/x/notes.md`", "/home/agent/work/x/notes.md"],
	["a markdown link target", "[notes](/home/agent/notes.md)", "/home/agent/notes.md"],
	[
		"the scratchpad under /home",
		"/home/agent/.hermes-janet/cache/scratch/s/a.png is the shot",
		"/home/agent/.hermes-janet/cache/scratch/s/a.png",
	],
	["$HOME", "written to $HOME/.cache/x.log", "$HOME/.cache/x.log"],
	["/run/user", "socket at /run/user/1000/bus", "/run/user/1000/bus"],
	["/nix/store", "built /nix/store/abc-foo-1.0/bin/foo", "/nix/store/abc-foo-1.0/bin/foo"],
	["/var/tmp", "dump in /var/tmp/core.1", "/var/tmp/core.1"],
	["a path on its own line", "Report:\n/tmp/report.txt\nthanks", "/tmp/report.txt"],
	["a path before a colon", "/tmp/x.log: 40 lines of errors", "/tmp/x.log"],
	["an italic path", "see _/tmp/a.log_ now", "/tmp/a.log"],
	["a bold path", "see **/home/agent/x** now", "/home/agent/x"],
	["a file:// URL", "open file:///home/agent/x.png", "/home/agent/x.png"],
	["a lone path in a fence", "see:\n```\n/home/agent/report.md\n```", "/home/agent/report.md"],
	["/root and /dev/shm", "in /root/x and /dev/shm/y", "/root/x"],
	["a path hidden outside the fence", "```\nok\n```\nnow /home/agent/x", "/home/agent/x"],
];

const PASSED: [string, string][] = [
	// Real messages: shared infrastructure, system files named as a topic, URLs, repo names.
	[
		"NAS path under /services",
		"It points at /services/turbo-cache on the NAS (good, not VM disk), but there's no quota.",
	],
	[
		"NAS backup path",
		"The voice evals and SPEC.md are now on the NAS at /services/janet-voice. The Unreal research went into envgen-sites #1.",
	],
	[
		"a system file as a topic",
		"Any other /word (/compact, /model, /etc/hosts): not a registered command.",
	],
	[
		"/etc/nixos as a topic",
		"It's the July baseline copy of the old /etc/nixos/configuration.nix from before the flake existed.",
	],
	["a GitHub PR link", "https://github.com/PetalNet/monorepo/pull/778"],
	[
		"a maps link",
		"https://www.google.com/maps/search/?api=1&query=Physics+Building+Missouri+S%26T+Rolla+MO",
	],
	[
		"a gallery link",
		"Same link, just reload: https://tasks.petalcat.dev/gallery/janet-voice-mixer",
	],
	// Look-alikes written for this guard.
	["a repo-relative nix file", "Edit modules/home/harness-guards.nix and flake.nix."],
	[
		"a relative path through home and tmp",
		"see src/tmp/a.ts, packages/home/b.ts and ./home/c.ts and ../tmp/d",
	],
	["a GitHub blob URL", "https://github.com/PetalNet/janet-nix/blob/master/modules/home/x.nix"],
	["a URL whose path has /home/", "https://example.org/home/agent/page and http://x.test/tmp/y"],
	[
		"a host-qualified path",
		"archived at .14:/srv/app-registry and nas:~/old and 10.10.10.12:/home/x/y",
	],
	["a Mac path for its owner", "Your file is at /Users/parker/Developer/x/README.md."],
	["a mount path", "mounted at /mnt/nas/Media"],
	["the bare words home and tmp", "go /home, then /tmp. and/or ~ means approximately ~5 GB"],
	["a tilde before a number", "about ~5 of them, ~2 GB, 3~4 days"],
	[
		"a path quoted in a fence",
		"Log:\n```\ncd /home/agent/x && ls\ntail ~/.claude/y\n```\nThat is the failing line.",
	],
	["a path quoted in a longer fence", "```sh\n/tmp/a\nls\n```\ntext\n```\n/home/b/c\nrm\n```"],
	["plain prose", "Done. PR is up and CI is green."],
	["empty text", ""],
];

describe("matrix-local-path-guard verdict", () => {
	it.each([...DENIED_REAL, ...DENIED_SHAPES])("denies %s", (_name, text, path) => {
		expect(verdict(send(text))).toBe(path);
		expect(localPath(text)).toBe(path);
	});

	it.each(PASSED)("passes %s", (_name, text) => {
		expect(verdict(send(text))).toBeNull();
	});

	it("ignores other tools, missing and non-string text, and bad input", () => {
		expect(verdict(send("/home/agent/x", "mcp__hermes-link__send_file"))).toBeNull();

		expect(
			verdict({ tool_name: "mcp__hermes-link__send_message", tool_input: { text: 12 } }),
		).toBeNull();

		expect(verdict({ tool_name: "mcp__hermes-link__send_message", tool_input: {} })).toBeNull();
		expect(verdict({ tool_name: "mcp__hermes-link__send_message" })).toBeNull();
		expect(verdict(null)).toBeNull();
	});
});

describe("matrix-local-path-guard as a hook process", () => {
	const script = fileURLToPath(new URL("matrix-local-path-guard.ts", import.meta.url));
	const run = (stdin: string) => {
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			input: stdin,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);

		return result.stdout;
	};

	it("prints a deny whose reason names the path and the fixes", () => {
		const out = JSON.parse(run(JSON.stringify(send("Full report: /home/agent/report.txt")))) as {
			hookSpecificOutput: {
				hookEventName: string;
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};
		const { hookEventName, permissionDecision, permissionDecisionReason } = out.hookSpecificOutput;

		expect(hookEventName).toBe("PreToolUse");
		expect(permissionDecision).toBe("deny");
		expect(permissionDecisionReason).toContain("/home/agent/report.txt");
		expect(permissionDecisionReason).toContain("inline in the message");
		expect(permissionDecisionReason).toContain("GitHub URL");
		expect(permissionDecisionReason).toContain("only for images, audio and video");
		expect(permissionDecisionReason).not.toContain("Send the file");
	});

	it("prints nothing for an allowed message", () => {
		expect(run(JSON.stringify(send("PR: https://github.com/PetalNet/monorepo/pull/1")))).toBe("");
	});

	it("fails open on bad input", () => {
		expect(run("not json")).toBe("");
	});
});
