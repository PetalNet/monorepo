// PreToolUse hook on the Matrix send tools (main thread only).
// 1. The send tool's default threads under the latest inbound message, which mis-threads when one arrives
//    mid-reply, so reply_to must be explicit (an event id, or "none").
// 2. The reader's client renders no markdown. This used to deny the send and cost a retry; it now rewrites the
//    text to plain prose through updatedInput, so it sends first time.
//
// One entry point, no dependencies beyond ./plain.ts: `node matrix-reply-threading.ts < payload.json`.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { plain } from "./plain.ts";

const TOOLS = new Set([
	"mcp__hermes-link__send_message",
	"mcp__claude-matrix-channel__matrix_reply",
]);

interface HookInput {
	readonly tool_name?: unknown;
	readonly agent_id?: unknown;
	readonly tool_input?: unknown;
}

interface Decision {
	readonly permissionDecision: "allow" | "deny";
	readonly permissionDecisionReason?: string;
	readonly updatedInput?: Record<string, unknown>;
	readonly additionalContext?: string;
}

/** What the hook says about a send, or `null` to stay silent. */
export function decide(input: HookInput | null): Decision | null {
	// agent_id marks a subagent; agent_type alone is also set on a main session started with --agent.
	if (
		!input ||
		typeof input.tool_name !== "string" ||
		!TOOLS.has(input.tool_name) ||
		input.agent_id
	) {
		return null;
	}

	const t: Record<string, unknown> =
		typeof input.tool_input === "object" && input.tool_input !== null
			? (input.tool_input as Record<string, unknown>)
			: {};

	if (!(typeof t["reply_to"] === "string" && t["reply_to"].length > 0)) {
		return {
			permissionDecision: "deny",
			permissionDecisionReason:
				'Set reply_to explicitly: the event_id of the message you are answering, or "none" for a flat message. ' +
				"The default threads under the latest inbound message, which mis-threads when a new message arrived meanwhile.",
		};
	}

	const field =
		typeof t["text"] === "string" ? "text" : typeof t["message"] === "string" ? "message" : null;

	if (field === null) {
		return null;
	}

	const original = t[field] as string;
	const { text: converted, leftover } = plain(original);

	// Not confident (markdown it can't safely convert, like 2**3 or a titled link) or nothing left: deny as before.
	if (leftover.length > 0 || (!converted.trim() && converted !== original)) {
		return {
			permissionDecision: "deny",
			permissionDecisionReason:
				`Markdown in a Matrix message (${leftover.join(", ") || "nothing left after removing it"}). The reader's client shows it raw. ` +
				'Rewrite as plain prose: no **, no backticks, no "- " bullets or # headers, bare https:// links on their own line.',
		};
	}

	if (converted === original) {
		return null;
	}

	// updatedInput replaces the whole input, so every other argument is carried over unchanged.
	return {
		permissionDecision: "allow",
		updatedInput: { ...t, [field]: converted },
		additionalContext:
			"Your message had markdown, which the reader's client shows raw; it was sent converted to plain text. Write plain text next time.",
	};
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	let input: HookInput | null;

	try {
		input = JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput | null;
	} catch {
		process.exit(0);
	}

	const decision = decide(input);

	if (decision !== null) {
		process.stdout.write(
			JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }),
		);
	}

	process.exit(0);
}
