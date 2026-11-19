import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isRecap, scan } from "./matrix-reply-reminder.ts";

const script = fileURLToPath(new URL("matrix-reply-reminder.ts", import.meta.url));
const HUMAN = /@human-a:example\.org|@human-b:example\.org|Player \(Minecraft\)/u;

const inbound = (kind: string, extra = "") =>
	`<channel source="hermes-link" sender="Alex" sender_id="@human-a:example.org" room_id="!room:example.org" event_id="$evt" kind="${kind}"${extra}>\nhi\n</channel>`;
const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (...content: unknown[]) => ({
	type: "assistant",
	message: { role: "assistant", content },
});
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string) => ({ type: "tool_use", name, input: {} });

interface Verdict {
	readonly decision?: string;
	readonly reason: string;
}

// Each state dir is a temp HOME: the loop-breaker counters never touch the real one.
const tempHome = () => mkdtempSync(path.join(tmpdir(), "mrr-"));

// Runs the hook against a transcript of `entries`; returns its parsed stdout (null when it stays silent).
const stop = (
	entries: unknown[],
	extra: Record<string, unknown> = {},
	home = tempHome(),
): Verdict | null => {
	const tp = path.join(home, "t.jsonl");

	writeFileSync(tp, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

	const r = spawnSync(process.execPath, ["--no-warnings", script], {
		input: JSON.stringify({ transcript_path: tp, ...extra }),
		encoding: "utf8",
		env: { ...process.env, HOME: home },
	});

	expect(r.status, r.stderr).toBe(0);

	return r.stdout ? (JSON.parse(r.stdout) as Verdict) : null;
};

const reply = assistant(tool("mcp__hermes-link__send_message"));
const recap =
	"Done. I changed the hook so that it reads the final text of the turn, and then I ran the tests, and they passed. ".repeat(
		4,
	);
const turn = (finalText: string) => [user(inbound("message")), reply, assistant(text(finalText))];

describe("matrix-reply-reminder reply gate", () => {
	it("needs no reply and no marker for an inbound reaction", () => {
		expect(
			stop([user(inbound("reaction", ' emoji="+1" relates_to="$x"')), assistant(text("ok"))]),
		).toBeNull();
	});

	it("passes an inbound reaction whose content is JSON-escaped", () => {
		expect(stop([user([text(inbound("reaction"))])])).toBeNull();
	});

	it("control: blocks an inbound message with no reply", () => {
		expect(stop([user(inbound("message")), assistant(text("ok"))])?.decision).toBe("block");
	});

	it("is not fooled by a reaction after an unanswered message", () => {
		expect(
			stop([user(inbound("message")), user(inbound("reaction")), assistant(text("ok"))])?.decision,
		).toBe("block");
	});

	it("control: a hermes-link reply, or an explicit marker, satisfies the gate", () => {
		expect(stop([user(inbound("message")), reply])).toBeNull();

		expect(
			stop([user(inbound("message")), assistant(text("[[silent-noop: background]]"))]),
		).toBeNull();
	});

	it("accepts the old matrix_reply tool family and the in-game reply", () => {
		for (const name of ["mcp__claude-matrix-channel__matrix_reply", "mcp__hermes-link__mc_reply"]) {
			expect(stop([user(inbound("message")), assistant(tool(name))])).toBeNull();
		}
	});

	it("ignores senders that are not on the human list", () => {
		const stranger = inbound("message").replace("@human-a:example.org", "@bot:example.org");

		expect(stop([user(stranger), assistant(text("ok"))])).toBeNull();
	});

	it("ignores user entries that are not Matrix channel messages", () => {
		expect(
			stop([user("a plain prompt from @human-a:example.org"), assistant(text("ok"))]),
		).toBeNull();
	});

	it("walks past tool results to the human message", () => {
		const result = user([{ type: "tool_result", content: "x" }]);

		expect(stop([user(inbound("message")), assistant(text("ok")), result])?.decision).toBe("block");
	});

	it("stays silent for a missing transcript path and for subagents", () => {
		const home = tempHome();
		const run = (payload: unknown) =>
			spawnSync(process.execPath, ["--no-warnings", script], {
				input: JSON.stringify(payload),
				encoding: "utf8",
				env: { ...process.env, HOME: home },
			});

		expect(run({}).stdout).toBe("");
		expect(run({ agent_id: "a1", transcript_path: "/nonexistent" }).stdout).toBe("");
	});

	it("fails open on bad input", () => {
		const r = spawnSync(process.execPath, ["--no-warnings", script], {
			input: "not json",
			encoding: "utf8",
			env: { ...process.env, HOME: tempHome() },
		});

		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("lets the turn end after two consecutive blocks (loop breaker)", () => {
		const home = tempHome();
		const entries = [user(inbound("message")), assistant(text("ok"))];

		expect(stop(entries, {}, home)?.decision).toBe("block");
		expect(stop(entries, {}, home)?.decision).toBe("block");
		expect(stop(entries, {}, home)).toBeNull();
		expect(stop(entries, {}, home)?.decision).toBe("block");
	}, 30_000);
});

describe("matrix-reply-reminder recap gate", () => {
	it("blocks a long final text after a Matrix reply (transcript fallback)", () => {
		const r = stop(turn(recap));

		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/RECAP GATE/u);
	});

	it("uses last_assistant_message from the Stop payload", () => {
		expect(
			stop([user(inbound("message")), reply], { last_assistant_message: recap })?.decision,
		).toBe("block");
	});

	it("passes a marker, a one-liner, or a long question", () => {
		expect(stop(turn("[[silent-noop: sent]]"))).toBeNull();
		expect(stop(turn("Sent."))).toBeNull();
		expect(stop(turn(`${recap}\n\nWant me to merge it?`))).toBeNull();
	});

	it("does not count a marker as prose, but a marker plus a recap is still a recap", () => {
		expect(stop(turn(`[[silent-noop: ${"x".repeat(400)}]]`))).toBeNull();
		expect(stop(turn(`${recap} [[silent-noop: sent]]`))?.decision).toBe("block");
	});

	it("never judges a turn that ends in a tool call", () => {
		expect(
			stop([user(inbound("message")), reply, assistant(text(recap), tool("Bash"))]),
		).toBeNull();
	});

	it("exempts subagents", () => {
		expect(stop(turn(recap), { agent_id: "a1" })).toBeNull();
	});

	it("blocks once, then the next stop of the same transcript ends the turn, then re-arms", () => {
		const home = tempHome();

		expect(stop(turn(recap), {}, home)?.decision).toBe("block");
		expect(stop(turn(recap), {}, home)).toBeNull();
		expect(stop(turn(recap), {}, home)?.decision).toBe("block");
	});

	it("clears the streak after a short reply", () => {
		const home = tempHome();

		expect(stop(turn(recap), {}, home)?.decision).toBe("block");
		expect(stop(turn("[[silent-noop: sent]]"), {}, home)).toBeNull();
		expect(stop(turn(recap), {}, home)?.decision).toBe("block");
	});

	it("lets the comms gate win when no reply was sent", () => {
		expect(stop([user(inbound("message")), assistant(text(recap))])?.reason).toMatch(/COMMS GATE/u);
	}, 15_000);

	it("treats a '?' in a URL or a quoted phrase as no pending question", () => {
		expect(stop(turn(`${recap} See https://example.com/page?id=1`))?.decision).toBe("block");

		expect(
			stop(turn(`${recap} I marked the "add notes maybe?" message with a check.`))?.decision,
		).toBe("block");
	});

	it("never blocks a stop that already follows a hook block", () => {
		expect(stop(turn(recap), { stop_hook_active: true })).toBeNull();
	});
});

describe("matrix-reply-reminder helpers", () => {
	it("isRecap: length threshold and last-paragraph question", () => {
		expect(isRecap("short")).toBe(false);
		expect(isRecap(recap)).toBe(true);
		expect(isRecap(`${recap}\n\nShall I go on?`)).toBe(false);
		expect(isRecap(`Is this fine?\n\n${recap}`)).toBe(true);
	});

	it("scan: null for an unreadable transcript, true when nothing is owed", () => {
		expect(scan(null, HUMAN)).toBeNull();
		expect(scan("", HUMAN)).toBe(true);
		expect(scan("{not json\n", HUMAN)).toBe(true);
	});

	it("scan: our own feedback entries are counted, and two of them release the gate", () => {
		const feedback = user("Stop hook feedback: COMMS GATE: reply");
		const lines = [user(inbound("message")), assistant(text("ok")), feedback, feedback]
			.map((e) => JSON.stringify(e))
			.join("\n");

		expect(scan(lines, HUMAN)).toBe(true);
		expect(scan(lines.split("\n").slice(0, 3).join("\n"), HUMAN)).toBe(false);
	});
});
