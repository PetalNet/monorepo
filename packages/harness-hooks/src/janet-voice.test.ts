import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { argv, judgePrompt, lint, packBody, parseVerdict } from "./janet-voice.ts";

const CLI = fileURLToPath(new URL("janet-voice.ts", import.meta.url));
const SKILL = readFileSync(
	new URL("../../../skills/janet-voice/SKILL.md", import.meta.url),
	"utf8",
);
const rules = (text: string) => lint(text).map((f) => f.rule);

// Posts in the form Janet sends to the lab's rooms (invented facts, her real shapes: answer first, numbered items
// that open with a label, a number range, a casual word, a repository-qualified pull request).
const JANET = [
	"Yes, cutting the tracker took the ongoing view with it, and that was a mistake. It's coming back, built from live data: open PRs with their CI and review state, and the needs-you items.",
	"Both fixed in janet-nix #64, merged and re-activated:\n1. Storage: its own dataset with a 50 GiB quota. Nothing is on the VM disk.\n2. CI: main pushes write and PRs read. The first numbers are 13 hits and 9 misses.",
	"My bad, reverted. The tunnel is back to ports 7681-7682 only. The build went from 681–926s to 334s on main.",
	"The cache is live at the address below. I tested it from a laptop, not from the build box.\nhttps://cache.example.org",
];

// What Gemini and GPT-OSS wrote from the same kind of brief with no pack loaded (shortened).
const RAW: [string, string, string][] = [
	[
		"markdown list with bold",
		"Here's how it will work:\n- The gallery will be organized under a **project > artifact** hierarchy.\n- Every view will have a direct URL.",
		"markdown: **bold**",
	],
	[
		"serves as",
		"I've only verified this against markdown parsers, so this message serves as a live test.",
		"stock phrase",
	],
	["an em dash", "The fix is live — it puts a space before the number.", "em or en dash"],
	[
		"a hyphen used as a dash",
		"The fix is live - it puts a space before the number.",
		"em or en dash",
	],
	["an exclamation and an emoji", "The cache is live! \u{1F680}", "exclamation mark"],
	["a closer", "The route is up. Let me know if you have any questions.", "stock phrase"],
	["a buzzword", "This is a robust fix for the cache.", "inflated word"],
	["an arrow", "Everything goes PR → review → merge.", "arrow"],
	[
		"a link with punctuation touching it",
		"The steps are at https://example.org/readme.",
		"link not bare",
	],
	["a link with no scheme", "The page is at cache.example.org/stats now.", "link without https://"],
	["a label", "Subject: cache status\nThe cache is live.", "label or wrapper"],
	[
		"not just X but Y",
		"This is not just a cache, but a whole new way to build.",
		"not just X but Y",
	],
	["curly quotes", "The “ongoing” view is back.", "curly quote"],
];

describe("lint", () => {
	it.each(JANET)("passes a post in Janet's form: %s", (post) => {
		expect(lint(post)).toEqual([]);
	});

	it.each(RAW)("fails %s", (_name, post, rule) => {
		expect(rules(post)).toContain(rule);
	});

	it("quotes the words that broke the rule", () => {
		expect(lint("The route is up. Let me know if you need more.")[0]?.quote).toContain(
			"Let me know if",
		);
	});

	it("reads a hyphenated name as a name, not as the inflated word", () => {
		expect(lint("The morning-showcase job ran at 9.")).toEqual([]);
	});

	it("does not read a container image as a link", () => {
		expect(lint("The image is ghcr.io/example/cache at v2.")).toEqual([]);
	});
});

describe("the pack", () => {
	const body = packBody(SKILL);

	it("is the skill without its frontmatter", () => {
		expect(body.startsWith("# Janet's voice")).toBe(true);
	});

	it("fits in one agy rule file, which is cut off at 24,000 bytes", () => {
		expect(Buffer.byteLength(body)).toBeLessThan(24_000);
	});

	it("gives examples that pass its own lint", () => {
		const examples = body.slice(body.indexOf("## Examples")).split("\n\n").slice(2);

		expect(examples).toHaveLength(2);

		for (const example of examples) {
			expect(lint(example.trim())).toEqual([]);
		}
	});
});

describe("judge", () => {
	it("adds the fact criteria only when the brief is given", () => {
		expect(judgePrompt("PACK", "post")).not.toContain("faithful:");
		expect(judgePrompt("PACK", "post", "13 hits")).toContain("faithful:");
		expect(judgePrompt("PACK", "post", "13 hits")).toContain("BRIEF\n13 hits");
	});

	it("never tells the judge who wrote the post", () => {
		expect(judgePrompt("PACK", "post", "brief")).not.toMatch(/gemini|gpt|codex|gemma|agy/iu);
	});

	it("reads the verdict out of an answer with text around it", () => {
		expect(
			parseVerdict('Sure.\n{"pass": false, "fails": [{"rule": "closer", "quote": "Thanks"}]}\n'),
		).toEqual({
			pass: false,
			fails: [{ rule: "closer", quote: "Thanks" }],
		});
	});

	it("fails a verdict that says pass and still lists a tell", () => {
		expect(parseVerdict('{"pass": true, "fails": [{"rule": "opener", "quote": "Hi"}]}')?.pass).toBe(
			false,
		);
	});

	it("returns null for an answer that is not the object", () => {
		expect(parseVerdict("I think it passes.")).toBeNull();
		expect(parseVerdict('{"verdict": "ok"}')).toBeNull();
	});
});

// A stand-in for agy on PATH. With no answer to give, it reports the rules file in its working directory, its
// arguments and a variable the caller must not pass on.
function fakeAgy(answer: string): string {
	const bin = mkdtempSync(path.join(tmpdir(), "fake-agy-"));
	const body =
		answer === ""
			? `printf 'rules=%s args=%s secret=[%s]' "$(cat AGENTS.md 2>/dev/null)" "$*" "$HUB_SECRET"`
			: `printf '%s' '${answer}'`;

	writeFileSync(path.join(bin, "agy"), `#!/bin/sh\n${body}\n`);
	chmodSync(path.join(bin, "agy"), 0o755);

	return bin;
}

const cli = (args: string[], input: string, bin: string, env: Record<string, string> = {}) =>
	spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, ...env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
	});

describe("write", () => {
	it("puts the prompt last for agy and keeps Codex read-only", () => {
		expect(argv("agy", "m", "PROMPT")).toEqual([
			"agy",
			"--model",
			"m",
			"--sandbox",
			"-p",
			"PROMPT",
		]);

		expect(argv("codex", "m", "PROMPT")).toEqual([
			"codex",
			"exec",
			"--skip-git-repo-check",
			"--sandbox",
			"read-only",
			"--model",
			"m",
			"PROMPT",
		]);
	});

	it("runs the harness in the workspace, so the workspace's AGENTS.md is the rules it loads", () => {
		const workspace = mkdtempSync(path.join(tmpdir(), "writer-"));

		writeFileSync(path.join(workspace, "AGENTS.md"), "PACK-RULES");

		const run = cli(
			["write", "--harness", "agy", "--model", "gemini-x", "--workspace", workspace],
			"13 hits, 9 misses\n",
			fakeAgy(""),
			{
				HUB_SECRET: "leak",
			},
		);

		expect(run.status).toBe(0);
		expect(run.stdout).toContain("rules=PACK-RULES");
		expect(run.stdout).toContain("--model gemini-x --sandbox -p Write the chat post");
		expect(run.stdout).toContain("13 hits, 9 misses");
		// The harness gets an allowlisted environment: a secret in the caller's environment does not reach it.
		expect(run.stdout).toContain("secret=[]");
	});

	it("refuses to write through agy with no workspace, because no pack would load", () => {
		const run = cli(["write", "--harness", "agy", "--model", "m"], "fact\n", fakeAgy("DRAFT"));

		expect(run.status).toBe(2);
		expect(run.stderr).toContain("--workspace");
	});
});

describe("check", () => {
	it("exits 1 on a lint failure without calling the judge", () => {
		const run = cli(["check", "--judge"], "**Done.** The cache is live.\n", fakeAgy("not json"));

		expect(run.status).toBe(1);
		expect(JSON.parse(run.stdout)).toMatchObject({ pass: false, judge: null });
	});

	it("passes a clean post the judge passes", () => {
		const run = cli(
			["check", "--judge"],
			"The cache is live. I tested it from a laptop.\n",
			fakeAgy('{"pass": true, "fails": []}'),
		);

		expect(run.status).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual({ pass: true, lint: [], judge: [] });
	});

	it("fails a clean post the judge fails, and one the judge gives no verdict on", () => {
		const post = "The cache is live. I tested it from a laptop.\n";
		const failed = cli(
			["check", "--judge"],
			post,
			fakeAgy('{"pass": false, "fails": [{"rule": "closer", "quote": "laptop"}]}'),
		);
		const garbled = cli(["check", "--judge"], post, fakeAgy("it looks fine"));

		expect(failed.status).toBe(1);

		expect(JSON.parse(failed.stdout)).toMatchObject({
			judge: [{ rule: "closer", quote: "laptop" }],
		});

		expect(garbled.status).toBe(1);
	});

	it("passes on lint alone when no judge is asked for", () => {
		expect(cli(["check"], "The cache is live.\n", fakeAgy("not json")).status).toBe(0);
	});
});
