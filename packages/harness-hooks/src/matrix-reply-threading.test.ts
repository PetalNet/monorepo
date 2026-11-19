import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decide } from "./matrix-reply-threading.ts";
import { detect, plain } from "./plain.ts";

const script = fileURLToPath(new URL("matrix-reply-threading.ts", import.meta.url));
const ROOM = "!room:example.org";
const TOOL = "mcp__hermes-link__send_message";

interface Output {
	readonly permissionDecision: string;
	readonly permissionDecisionReason?: string;
	readonly updatedInput: Record<string, string>;
	readonly additionalContext?: string;
}

// Drives the hook the way Claude Code does: hook input JSON on stdin, decision JSON on stdout.
const spawnHook = (payload: string) => {
	const r = spawnSync(process.execPath, ["--no-warnings", script], {
		input: payload,
		encoding: "utf8",
	});

	expect(r.status, r.stderr).toBe(0);

	return r.stdout;
};

const run = (toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
	const out = spawnHook(JSON.stringify({ tool_name: TOOL, tool_input: toolInput, ...extra }));

	return out ? (JSON.parse(out) as { hookSpecificOutput: Output }).hookSpecificOutput : null;
};

const send = (t: string) => run({ room: ROOM, reply_to: "none", text: t });

describe("matrix-reply-threading hook process", () => {
	it("sends bulleted markdown converted, with every other argument intact", () => {
		const t =
			"# Status\n**Two** things:\n- the `nix build` passed\n- see [PR 21](https://example.com/org/repo/pull/21)\n\nDone.";
		const r = run({ room: ROOM, reply_to: "$ev", text: t, msgtype: "text" });

		expect(r?.permissionDecision).toBe("allow");

		expect(r?.updatedInput).toEqual({
			room: ROOM,
			reply_to: "$ev",
			msgtype: "text",
			text: "Status\nTwo things:\n1. the nix build passed\n2. see PR 21: https://example.com/org/repo/pull/21\n\nDone.",
		});

		expect(r?.additionalContext).toContain("converted to plain text");
	});

	it("prints nothing for plain text", () => {
		expect(send("Done. 1. first\n2. second, see https://example.com/a_b*c")).toBeNull();
	});

	it("drops code fences, keeps their contents, restarts numbering after prose, leaves + alone", () => {
		expect(send("```\nls -la\n```\n* a\n* b\nthen\n+ c")?.updatedInput["text"]).toBe(
			"ls -la\n1. a\n2. b\nthen\n+ c",
		);
	});

	it("denies a missing reply_to, markdown or not", () => {
		expect(run({ room: ROOM, text: "- hi" })?.permissionDecision).toBe("deny");
		expect(run({ room: ROOM, text: "hi" })?.permissionDecision).toBe("deny");
		expect(run({ room: ROOM, reply_to: "", text: "hi" })?.permissionDecision).toBe("deny");

		expect(run({ room: ROOM, text: "hi" })?.permissionDecisionReason).toContain(
			"Set reply_to explicitly",
		);
	});

	it("leaves subagents and other tools alone", () => {
		expect(run({ room: ROOM, reply_to: "none", text: "- hi" }, { agent_id: "a1" })).toBeNull();

		expect(spawnHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "- hi" } }))).toBe(
			"",
		);
	});

	it("denies what it cannot convert safely, never mangling it", () => {
		for (const t of [
			"2**3 + 4**2 = 24",
			"f(**opts, **extra)",
			"use `a**b**c`",
			'[t](https://example.com "title")',
			"[a b](https://example.com/a b)",
		]) {
			expect(send(t)?.permissionDecision, t).toBe("deny");
		}

		expect(send("```oops``` only")?.updatedInput["text"]).toBe("oops only");
	});

	it("leaves code inside a fence exactly as written", () => {
		expect(
			send("Config:\n```yaml\n# install\n- one\n- two\n```\n- after")?.updatedInput["text"],
		).toBe("Config:\n# install\n- one\n- two\n1. after");
	});

	it("numbers nested and loose lists per level, counting across blank lines", () => {
		expect(send("- a\n  - a1\n  - a2\n- b\n\n- c\nend\n- d")?.updatedInput["text"]).toBe(
			"1. a\n  1. a1\n  2. a2\n2. b\n\n3. c\nend\n1. d",
		);
	});

	it("passes text the old deny-only hook passed", () => {
		for (const t of [
			"  # indented comment",
			"+ 1 more thing",
			"-5 degrees, +1",
			"snake_case and a_b*c",
			"",
		]) {
			expect(send(t), JSON.stringify(t)).toBeNull();
		}
	});

	it("denies an unclosed fence; a fence with an info string is still a fence", () => {
		expect(
			send("```\n**unclosed** fence\n- bullet\n[t](https://example.com)")?.permissionDecision,
		).toBe("deny");

		expect(send("```js title\nconst a = 1\n```")?.updatedInput["text"]).toBe("const a = 1");
	});

	it("converts the message field when there is no text field, and passes when there is neither", () => {
		expect(
			run({ room: ROOM, reply_to: "none", message: "**hi** there" })?.updatedInput["message"],
		).toBe("hi there");

		expect(run({ room: ROOM, reply_to: "none" })).toBeNull();
	});

	it("also guards the old matrix_reply tool", () => {
		const out = spawnHook(
			JSON.stringify({
				tool_name: "mcp__claude-matrix-channel__matrix_reply",
				tool_input: { text: "hi" },
			}),
		);

		expect(out).toContain('"permissionDecision":"deny"');
	});

	it("fails open on bad input and treats empty input as an empty payload", () => {
		expect(spawnHook("not json")).toBe("");
		expect(spawnHook("")).toBe("");
	});
});

describe("matrix-reply-threading decide and plain", () => {
	it("decide returns null for non-send input", () => {
		expect(decide(null)).toBeNull();
		expect(decide({ tool_name: "Read" })).toBeNull();
	});

	it("decide denies when the converted text would be empty", () => {
		expect(
			decide({ tool_name: TOOL, tool_input: { reply_to: "none", text: "```\n```" } })
				?.permissionDecision,
		).toBe("deny");
	});

	it("plain reports what it could not convert", () => {
		expect(plain("2**3 + 4**2").leftover).toEqual(["**bold**"]);
		expect(detect("**a** `b` - x")).toEqual(["**bold**", "backticks"]);

		expect(detect("- x\n# h\n[t](https://a.b)")).toEqual([
			'leading "- " bullet',
			"# header",
			"[text](url) link",
		]);
	});
});
