// A promoted command must announce its own completion: the run script leaves a .job record, the notify hook
// (PostToolUse / UserPromptSubmit) surfaces it once, for the session that started it, after the .exit file lands.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "mtbn-"));
const out = path.join(home, ".claude/shared/main-thread-budget-out");

mkdirSync(out, { recursive: true });
const env = { ...process.env, HOME: home, MTB_WAIT_MS: "300" };

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

const notify = (extra: Record<string, unknown> = {}) => {
	const r = spawnSync(process.execPath, ["--no-warnings", here("./main-thread-budget-notify.ts")], {
		input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "S1", ...extra }),
		env,
		encoding: "utf8",
	});

	return r.stdout
		? (
				JSON.parse(r.stdout) as {
					hookSpecificOutput: { hookEventName: string; additionalContext: string };
				}
			).hookSpecificOutput
		: null;
};

const promote = (command: string, session: string) =>
	spawnSync(
		process.execPath,
		[
			"--no-warnings",
			here("./main-thread-budget-run.ts"),
			"300",
			Buffer.from(command).toString("base64"),
		],
		{ env: { ...env, MTB_SESSION: session }, encoding: "utf8" },
	);
const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

describe("notify", () => {
	it("is silent when nothing was promoted (control)", () => {
		expect(notify()).toBeNull();
	});

	it("announces a promoted command once, after it finishes, with exit code and output tail", async () => {
		const r = promote("sleep 1; echo finished-marker; exit 3", "S1");

		expect(r.stdout).toMatch(/still running/u);
		expect(readdirSync(out).some((f) => f.endsWith(".job"))).toBe(true);
		expect(notify(), "still running: no notice yet").toBeNull();
		await sleep(1800);
		const n = notify();

		expect(n?.hookEventName).toBe("PostToolUse");
		expect(n?.additionalContext).toMatch(/finished with exit code 3/u);
		expect(n?.additionalContext).toMatch(/finished-marker/u);
		expect(n?.additionalContext).toMatch(/\.out/u);
		expect(notify(), "announced once only").toBeNull();
	}, 15000);

	it("lets another session, and subagents, leave the notice alone", async () => {
		promote("sleep 1; echo mine", "S2");
		await sleep(1800);

		expect(notify({ session_id: "S1" })).toBeNull();
		expect(notify({ session_id: "S2", agent_id: "sub1" })).toBeNull();

		expect(
			notify({ session_id: "S2", hook_event_name: "UserPromptSubmit" })?.additionalContext,
		).toMatch(/mine/u);
	}, 15000);

	it("keeps leading env assignments (possible tokens) out of the job record and the notice", async () => {
		promote("SECRETVAR=hunter2 sleep 1; echo hi", "S3");
		await sleep(1800);
		const n = notify({ session_id: "S3" });

		expect(n?.additionalContext).toBeDefined();
		expect(n?.additionalContext).not.toMatch(/hunter2|SECRETVAR/u);
	}, 15000);

	it("ignores bad input and a missing state dir", () => {
		const r = spawnSync(
			process.execPath,
			["--no-warnings", here("./main-thread-budget-notify.ts")],
			{
				input: "not json",
				env,
				encoding: "utf8",
			},
		);

		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
	});
});
