import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verdict } from "./agent-brief-guard.ts";

const agent = (
	prompt: string,
	tool: Record<string, unknown> = {},
	top: Record<string, unknown> = {},
) => ({
	tool_name: "Agent",
	tool_input: { prompt, subagent_type: "general-purpose", ...tool },
	...top,
});

// Invented briefs: each one is a shape the guard must deny, or a look-alike it must let through.
const DENIED: [string, string, string][] = [
	[
		"numbered imperative steps",
		"Goal: ship the widget.\n1. Read the module.\n2. Write the fix.\n3. Run the tests.\n",
		"3 numbered steps",
	],
	[
		"numbered with parentheses",
		"Plan:\n1) Clone it.\n2) Patch it.\n3) Push it.\n4) Open a PR.",
		"4 numbered steps",
	],
	["Step N lines", "Step 1: read it\nStep 2: fix it\nStep 3: test it", "3 numbered steps"],
	[
		"CRLF line endings",
		"Goal\r\n1. Read the code.\r\n2. Fix it.\r\n3. Run tests.\r\n",
		"3 numbered steps",
	],
	[
		"conditional openers count as steps",
		"Do this:\n1. If the cache is cold, warm it.\n2. Before merging, rebase.\n3. Once green, merge.",
		"3 numbered steps",
	],
	[
		"sequencers in prose",
		"First find the repo. Then fix the bug. Finally open a PR.",
		"3 first/then/next/finally steps",
	],
	[
		"sequencers in bullets",
		"Goal: x.\n- First, read it\n- Next, change it\n- Finally, test it",
		"3 first/then/next/finally steps",
	],
	[
		"a fenced block does not hide the real steps after it",
		"Log:\n```\nignored\n```\n1. Read a\n2. Fix b\n3. Run c",
		"3 numbered steps",
	],
];

const PASSED: [string, string][] = [
	["bullets", "Goal: x.\n- Read the code.\n- Write the fix.\n- Run the tests.\n- Open a PR."],
	[
		"numbered facts",
		"Facts:\n1. The repo is at /srv/x.\n2. Tests use node --test.\n3. Main is protected.",
	],
	[
		"numbered constraints",
		"Constraints:\n1. Never push to main.\n2. Do not touch the lockfile.\n3. Only use the lab token.",
	],
	[
		"numbered questions",
		"Questions:\n1. Does it duck audio?\n2. Can it resume?\n3. Is there a finished signal?",
	],
	[
		"imperative items under a criteria lead-in",
		"Done when:\n1. Run `node --test` and it passes.\n2. Check the README.\n3. Verify no secrets.",
	],
	[
		"deliverables",
		"Deliverables:\n1. Report the root cause.\n2. List the files changed.\n3. Show the test output.",
	],
	["two numbered steps are not a plan", "1. Read the code.\n2. Fix it.\n"],
	["one or two sequencers", "Fix the bug. Then open a PR."],
	[
		"then, next and first mid-sentence",
		"If it fails then retry, and if that fails then stop; the first run is slow, the next is fast.",
	],
	[
		"names that start with a sequencer word",
		"Context: Next.js app. Second opinion wanted. First principles matter. Then-branch stays.",
	],
	[
		"steps quoted in a code fence",
		"Log:\n```\nFirst clone. Then build. Finally push.\n1. a\n```\nGoal: x.",
	],
];

describe("agent-brief-guard verdict", () => {
	it.each(DENIED)("denies %s", (_name, prompt, why) => {
		expect(verdict(agent(prompt))).toBe(why);
	});

	it.each(PASSED)("passes %s", (_name, prompt) => {
		expect(verdict(agent(prompt))).toBeNull();
	});

	const steps = "Goal: ship it.\n1. Read the code.\n2. Write the fix.\n3. Run the tests.\n";

	it("denies the same steps from the Task tool", () => {
		expect(verdict({ tool_name: "Task", tool_input: { prompt: steps } })).toBe("3 numbered steps");
	});

	it("exempts the planner and Plan subagents", () => {
		expect(verdict(agent(steps, { subagent_type: "planner" }))).toBeNull();
		expect(verdict(agent(steps, { subagent_type: "Plan" }))).toBeNull();
	});

	it("exempts subagents, which carry an agent_id", () => {
		expect(verdict(agent(steps, {}, { agent_id: "a1b2" }))).toBeNull();
	});

	it("ignores other tools and non-string prompts", () => {
		expect(verdict({ tool_name: "Bash", tool_input: { prompt: steps } })).toBeNull();
		expect(verdict({ tool_name: "Agent", tool_input: { prompt: 12 } })).toBeNull();
		expect(verdict(null)).toBeNull();
	});
});

describe("agent-brief-guard as a hook process", () => {
	const script = fileURLToPath(new URL("agent-brief-guard.ts", import.meta.url));
	const run = (stdin: string) => {
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			input: stdin,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);

		return result.stdout;
	};

	it("prints a deny whose reason names the fix", () => {
		const out = JSON.parse(run(JSON.stringify(agent("1. Read a\n2. Fix b\n3. Run c")))) as {
			hookSpecificOutput: {
				hookEventName: string;
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};

		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");

		expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
			"Give the goal, what proves it done, and hard constraints; let the worker plan. If it needs a plan, spawn subagent_type planner first.",
		);
	});

	it("prints nothing for an allowed brief", () => {
		expect(run(JSON.stringify(agent("Goal: x. Done when: y.")))).toBe("");
	});

	it("fails open on bad input", () => {
		expect(run("not json")).toBe("");
	});
});
