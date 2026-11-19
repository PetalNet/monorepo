import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { newSurfaceVerdict, verdict } from "./agent-brief-guard.ts";

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

// Shapes taken from real past Janet briefs (names and details removed): what fired, and what must stay quiet.
const DENY_SURFACE: [string, string][] = [
	[
		"a small SvelteKit web app",
		"Build a small web app that shows a friend group when they are all free. Stack: SvelteKit 2 + Svelte 5, TypeScript, pnpm. Deploy to a dev host.",
	],
	[
		"a server in TypeScript or Python, language left open",
		"Goal: a live server for the notes app. Pick the language that fits (TypeScript/Bun or Express are fine). Create a new HTTP server with a PUT /v1/surface endpoint.",
	],
	["Hono", "Stand up a new Hono API that returns the build status, and deploy it behind Traefik."],
	["a bare +server.ts", "Create an endpoint in a +server.ts route that returns the queue depth."],
];

const NUDGE_SURFACE: [string, string][] = [
	[
		"a small FastAPI service",
		"Build a small FastAPI service for the media box that rate-limits the downloader.",
	],
	[
		"a read-only MCP server",
		"Build a read-only MCP server for the campus portal, with three tools.",
	],
	["a Python daemon", "Create a new daemon that polls the usage feed and posts to Matrix."],
];

const QUIET_SURFACE: [string, string][] = [
	[
		"names effect-sveltekit",
		"Build a new web app on packages/effect-sveltekit and effect-api. Read both and apps/grove first.",
	],
	[
		"states a reason",
		"Build a new HTTP service in Express. not effect-sk because: it must match the vendor's SDK.",
	],
	["research", "Research how to build a new Hono service on Bun and compare it with SvelteKit."],
	["review", "Review the PR that adds a new Express endpoint for correctness and report."],
	[
		"validation only",
		"VALIDATION ONLY: prove we can read the inbox; do not build the production sidecar yet.",
	],
	["a fix to an existing app", "Fix the failing test in the SvelteKit app and open a PR."],
	["a deploy", "Deploy the merged main of the web service to the lab host and verify health."],
	["a hook", "Write a new Claude Code hook in TypeScript that blocks secrets."],
	[
		"model inference",
		"Build a small service that runs Whisper inference on audio uploaded over HTTP.",
	],
	["a Flutter app", "Build a Flutter app with a small API client for the lab."],
	["a Rust service", "Create a new Rust service with axum that serves the manifest."],
	["a CLI", "Build a CLI that prints the usage table."],
	[
		"inference service whose client types are TypeScript",
		"Build a new service that runs Whisper inference; ship TypeScript client types for it.",
	],
	[
		"a Rust service with a SvelteKit dashboard",
		"Create a new Rust service with a SvelteKit dashboard in the repo.",
	],
	[
		"a data exporter tested in TypeScript",
		"Build a new data-lake exporter service; tests are in TypeScript.",
	],
	["no service at all", "Fix the flaky test in the planner module and report root cause."],
];

describe("newSurfaceVerdict", () => {
	it.each(DENY_SURFACE)("denies %s", (_name, prompt) => {
		expect(newSurfaceVerdict(agent(prompt))).toBe("deny");
	});

	it.each(NUDGE_SURFACE)("nudges %s", (_name, prompt) => {
		expect(newSurfaceVerdict(agent(prompt))).toBe("nudge");
	});

	it.each(QUIET_SURFACE)("stays quiet for %s", (_name, prompt) => {
		expect(newSurfaceVerdict(agent(prompt))).toBeNull();
	});

	it("exempts read-only subagent types and subagents", () => {
		const prompt = "Build a new Express server.";

		expect(newSurfaceVerdict(agent(prompt, { subagent_type: "code-reviewer" }))).toBeNull();
		expect(newSurfaceVerdict(agent(prompt, { subagent_type: "planner" }))).toBeNull();
		expect(newSurfaceVerdict(agent(prompt, {}, { agent_id: "a1" }))).toBeNull();
	});

	it("ignores other tools, bad input and fenced code", () => {
		expect(
			newSurfaceVerdict({ tool_name: "Bash", tool_input: { prompt: "Build an Express server" } }),
		).toBeNull();

		expect(newSurfaceVerdict(null)).toBeNull();

		expect(
			newSurfaceVerdict(agent("Fix the bug.\n```\nbuild a new Express server\n```")),
		).toBeNull();
	});
});

describe("agent-brief-guard effect default as a hook process", () => {
	const script = fileURLToPath(new URL("agent-brief-guard.ts", import.meta.url));
	const run = (prompt: string) => {
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			input: JSON.stringify(agent(prompt)),
			encoding: "utf8",
		});

		expect(result.status).toBe(0);

		return result.stdout === ""
			? null
			: (JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> });
	};

	it("denies a new Express service and names the fix", () => {
		const out = run("Build a new Express server for the dashboard.");

		expect(out?.hookSpecificOutput.permissionDecision).toBe("deny");

		expect(out?.hookSpecificOutput.permissionDecisionReason).toContain(
			"packages/effect-sveltekit and packages/effect-api",
		);

		expect(out?.hookSpecificOutput.permissionDecisionReason).toContain("apps/grove");
		expect(out?.hookSpecificOutput.permissionDecisionReason).toContain("not effect-sk because");
	});

	it("only nudges a small FastAPI service, without a decision", () => {
		const out = run("Build a small FastAPI service that returns the time.");

		expect(out?.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(out?.hookSpecificOutput.additionalContext).toContain("effect-sveltekit");
	});

	it("fails open on malformed input and handles the Task tool", () => {
		const bad = spawnSync(process.execPath, ["--no-warnings", script], {
			input: "{",
			encoding: "utf8",
		});

		expect(bad.status).toBe(0);
		expect(bad.stdout).toBe("");

		expect(
			newSurfaceVerdict({
				tool_name: "Task",
				tool_input: { prompt: "Build a new Express server." },
			}),
		).toBe("deny");
	});

	it("prints nothing for a brief that names the packages", () => {
		expect(run("Build a new service on effect-api.")).toBeNull();
	});
});
