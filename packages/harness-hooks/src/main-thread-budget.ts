// main-thread-budget: a PreToolUse hook on Bash. Matrix messages arrive only between tool calls, so no call may
// block the main thread for long. Commands that obviously take long (main-thread-budget-classify.ts) are moved to
// the background at once. Every other command is rewritten through updatedInput to run under
// main-thread-budget-run.ts: foreground for up to WAIT_MS, returning real output and exit code inline, else detached
// with a "still running" note. Subagents (agent_id present) are exempt.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { firstWords, isLong } from "./main-thread-budget-classify.ts";

interface HookInput {
	readonly tool_name?: unknown;
	readonly agent_id?: unknown;
	readonly session_id?: unknown;
	readonly tool_input?: {
		readonly command?: unknown;
		readonly timeout?: unknown;
		readonly run_in_background?: unknown;
	} & Record<string, unknown>;
}

const WAIT_MS = Number(process.env["MTB_WAIT_MS"]) || 5000;
const LONG_TIMEOUT_MS = 60000;
const RUN = fileURLToPath(new URL("main-thread-budget-run.ts", import.meta.url));
const q = (x: string) => `'${x.replace(/'/gu, `'\\''`)}'`;
const LOG = `${String(process.env["HOME"])}/.claude/shared/main-thread-budget.log`;

let input: HookInput = {};

try {
	input = JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput;
} catch {
	process.exit(0);
}

if (input.tool_name !== "Bash") {
	process.exit(0);
}

const t = input.tool_input ?? {};
// agent_id marks a subagent; agent_type alone is also set on a main session started with --agent.
const isSub = Boolean(input.agent_id);
const long = isLong(t.command) || (typeof t.timeout === "number" && t.timeout >= LONG_TIMEOUT_MS);

let action = "pass";
let updatedInput: Record<string, unknown> | null = null;

if (!isSub && t.run_in_background !== true && typeof t.command === "string") {
	if (long) {
		action = "background";
		updatedInput = { ...t, run_in_background: true };
	} else {
		action = "wrap";

		const sess =
			typeof input.session_id === "string" ? input.session_id.replace(/[^\w-]/gu, "") : "";
		const wrapped = `${sess ? `MTB_SESSION=${sess} ` : ""}${q(process.execPath)} --no-warnings ${q(RUN)} ${String(WAIT_MS)} ${Buffer.from(t.command).toString("base64")}${typeof t.timeout === "number" && t.timeout > 0 ? ` ${String(t.timeout)}` : ""}`;

		updatedInput = { ...t, command: wrapped };

		if (typeof t.timeout === "number" && t.timeout < WAIT_MS + 5000) {
			updatedInput["timeout"] = WAIT_MS + 5000;
		}
	}
}

try {
	// Command words and length only, never the command text: it can carry tokens.
	appendFileSync(
		LOG,
		`${JSON.stringify({
			ts: new Date().toISOString(),
			isSub,
			long,
			action,
			timeout: t.timeout ?? null,
			bg: t.run_in_background ?? false,
			words: firstWords(t.command),
			len: (typeof t.command === "string" ? t.command : "").length,
		})}\n`,
	);
} catch {
	/* logging never blocks */
}

if (updatedInput) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput,
				...(action === "background" && {
					additionalContext:
						"Main-thread budget: this command looks long-running, so it was started in the background. " +
						"You will be notified when it finishes; read its output file then. Do not poll or sleep.",
				}),
			},
		}),
	);
}

process.exit(0);
