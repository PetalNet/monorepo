// Every message, room and name here is invented. The inject and vault commands are real scripts in a temp
// directory, so the ledger runs them the way it runs the real ones.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { delivers } from "./promise-close.ts";
import { classify, detect } from "./promise-detect.ts";
import { instant, parseDue } from "./promise-due.ts";
import type { Config } from "./promise-ledger.ts";
import { configFromEnv, depsFromEnv, Ledger, statusLine } from "./promise-ledger.ts";
import { when } from "./promise.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TZ = { timeZone: "America/Chicago", resetHour: 4 };
// A Thursday, 14:00 in Chicago (UTC-6 in January).
const T0 = Date.UTC(2026, 0, 15, 20, 0);
const dirs: string[] = [];

afterAll(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
});

describe("detect", () => {
	it.each([
		["I'll send the build link once the checks pass.", "future"],
		["I’m going to rerun the import overnight.", "future"],
		["You'll get the comparison as a table.", "delivery"],
		["Screenshots to follow.", "delivery"],
		["The summary will land in the channel tonight.", "delivery"],
		["Next: wire the importer, then I send the numbers.", "delivery"],
		["On it.", "working"],
		["Checking the logs now.", "working"],
		["The exporter is being rebuilt now.", "working"],
	])("finds a promise in %j", (sentence, kind) => {
		expect(classify(sentence)).toBe(kind);
	});

	it.each([
		"Want me to rerun the import?",
		"Say the word and I'll roll it back.",
		"If you want the long version, I'll write it up.",
		"Send me the serial number and I'll register it.",
		"The import finished and the table has 412 rows.",
		"Fixed, the exporter no longer drops empty rows.",
		"I'll never post there without asking.",
	])("leaves %j alone", (sentence) => {
		expect(classify(sentence)).toBeUndefined();
	});

	it("returns each promising sentence of a message and skips quoted and fenced text", () => {
		const found = detect(
			"Done with the first half. I'll post the second half after lunch.\n> I'll be late\n```\nI'll run in code\n```\nOn it.",
		);

		expect(found.map((f) => f.sentence)).toEqual([
			"I'll post the second half after lunch.",
			"On it.",
		]);
	});
});

describe("parseDue", () => {
	const local = (day: number, hour: number, minute = 0) =>
		instant(TZ.timeZone, 2026, 1, day, hour, minute);

	it.each([
		["I'll send it tomorrow.", local(16, 20)],
		["I'll send it tomorrow morning.", local(16, 12)],
		["You'll have it tonight.", local(15, 23, 30)],
		["I'll run it after the reset.", local(16, 8)],
		["I'll check on Friday 9.", local(16, 10)],
		["I'll look again on Monday.", local(19, 20)],
		["I'll send the list in 20 minutes.", T0 + 30 * MINUTE],
		["I'll have numbers in 2 hours.", T0 + 3 * HOUR],
		["I'll call at 4:45.", local(15, 17, 45)],
		["I'll pull it on Jan 22.", local(22, 20)],
	])("reads %j", (sentence, at) => {
		expect(parseDue(sentence, T0, TZ)?.at).toBe(at);
	});

	it("states nothing for a promise with no time, or a time already past", () => {
		expect(parseDue("I'll send the link once it's verified.", T0, TZ)).toBeUndefined();
		expect(parseDue("I'll call at 9am.", T0, TZ)).toBeUndefined();
	});

	it("reads the snooze forms", () => {
		const config = { ...configFromEnv(), ...TZ };

		expect(when("90m", T0, config)).toBe(T0 + 90 * MINUTE);
		expect(when("2026-01-20T09:30", T0, config)).toBe(local(20, 9, 30));
		expect(when("tomorrow", T0, config)).toBe(local(16, 20));
		expect(when("soonish", T0, config)).toBeUndefined();
	});
});

describe("delivers", () => {
	const promise = "I'll mirror the calendar feed into the shared planner as busy blocks.";

	it("closes on a plain report that names the same things", () => {
		expect(
			delivers(promise, "The calendar feed is live in the shared planner as busy blocks."),
		).toBeDefined();
	});

	it.each([
		"The calendar feed for the planner is not live yet, the busy blocks fail.",
		"I'll have the calendar feed in the planner as busy blocks tonight.",
		"Is the calendar feed in the planner showing busy blocks?",
		"The planner is live.",
		"Fixed the login page.",
		"Calendar feed and planner busy blocks get checked every night.",
	])("stays open on %j", (later) => {
		expect(delivers(promise, later)).toBeUndefined();
	});
});

describe("ledger", () => {
	let dir = "";
	let config: Config;
	let now = T0;
	let history: DatabaseSync;
	let entries = 0;

	const say = (
		text: string,
		options: { room?: string; surface?: string; direction?: string; ref?: string } = {},
	) => {
		entries += 1;

		history
			.prepare(
				"INSERT INTO entry (ts, surface, channel, branch, direction, sender, text, ref) VALUES (?, ?, ?, 'main', ?, 'agent', ?, ?)",
			)
			.run(
				now / 1000,
				options.surface ?? "chat",
				options.room ?? "!room-a",
				options.direction ?? "out",
				text,
				options.ref ?? `$evt${String(entries)}`,
			);

		return entries;
	};

	const open = () => new Ledger(config, { ...depsFromEnv(), now: () => now });
	const sweep = () => {
		const ledger = open();

		try {
			return ledger.sweep();
		} finally {
			ledger.close();
		}
	};

	const using = <T>(fn: (ledger: Ledger) => T) => {
		const ledger = open();

		try {
			return fn(ledger);
		} finally {
			ledger.close();
		}
	};

	const injected = () =>
		existsSync(path.join(dir, "inject.log"))
			? readFileSync(path.join(dir, "inject.log"), "utf8").split("\u0000").filter(Boolean)
			: [];
	const vaulted = () =>
		existsSync(path.join(dir, "vault.log"))
			? readFileSync(path.join(dir, "vault.log"), "utf8").trim().split("\n")
			: [];
	const script = (name: string, body: string) => {
		writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
		chmodSync(path.join(dir, name), 0o755);
	};

	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "promise-"));
		dirs.push(dir);
		now = T0;
		entries = 0;
		history = new DatabaseSync(path.join(dir, "history.db"));

		history.exec(
			"CREATE TABLE entry (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, surface TEXT, channel TEXT, branch TEXT, direction TEXT, sender TEXT, text TEXT, ref TEXT)",
		);

		// The fake hub: it remembers keys, as the real one does, and fails while a file named `down` exists.
		script(
			"inject",
			`[ -e "${dir}/down" ] && { echo "hub unreachable" >&2; exit 1; }
if grep -qxF "$4" "${dir}/keys" 2>/dev/null; then echo "already queued $4" >&2; exit 0; fi
echo "$4" >> "${dir}/keys"; { printf '%s|%s|' "$2" "$4"; cat; printf '\\0'; } >> "${dir}/inject.log"; echo "queued 1" >&2`,
		);

		script(
			"vault",
			`[ -e "${dir}/vault-down" ] && exit 255
echo "$*" >> "${dir}/vault.log"; n=$(wc -l < "${dir}/vault.log"); printf '{"id":"c-test%04d"}\\n' "$n"`,
		);

		process.env["PROMISE_INJECT"] = path.join(dir, "inject");
		process.env["PROMISE_VAULT"] = path.join(dir, "vault");

		config = {
			...configFromEnv(),
			...TZ,
			store: path.join(dir, "state", "ledger.sqlite"),
			history: path.join(dir, "history.db"),
			graceMs: 4 * HOUR,
			promptEveryMs: HOUR,
			promptCap: 3,
			backoffMs: [6 * HOUR, 24 * HOUR],
		};

		// The first sweep only places the cursor.
		say("I'll send the old thing that predates the ledger.");
		sweep();
	});

	it("starts from now: messages older than the ledger are not promises it tracks", () => {
		expect(using((l) => l.items())).toEqual([]);
	});

	it("captures a promise with its room, event, pointer and a default due time", () => {
		say("Can you check the importer?", { direction: "in", ref: "$ask1" });
		say("On it. I'll send the row counts once the import finishes.", { ref: "$promise1" });
		say("NONE", { surface: "cli" });
		sweep();

		const [item, ...rest] = using((l) => l.items());

		expect(rest).toEqual([]);

		expect(item).toMatchObject({
			kind: "promise",
			room: "!room-a",
			event_id: "$promise1",
			entry_id: 3,
			pointer: "event:$ask1",
			text: "I'll send the row counts once the import finishes.",
			due: T0 + 4 * HOUR,
			due_source: "default",
		});

		expect(JSON.parse(item?.more ?? "[]")).toEqual(["On it."]);
	});

	it("binds a stated time, and ignores the terminal surface", () => {
		say("I'll post the audit tomorrow morning.");
		say("I'll do it tonight.", { surface: "cli" });
		sweep();

		const items = using((l) => l.items());

		expect(items).toHaveLength(1);

		expect(items[0]).toMatchObject({
			due: instant(TZ.timeZone, 2026, 1, 16, 12),
			due_source: "stated: tomorrow morning",
		});
	});

	it("reminds once when a promise is overdue, and a repeated tick queues nothing new", () => {
		say("I'll send the row counts once the import finishes.");
		sweep();
		now += 4 * HOUR + MINUTE;
		expect(sweep()).toMatchObject({ remind: { sent: 1, failed: 0 } });
		sweep();
		now += 30 * MINUTE;
		sweep();

		const sent = injected();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("#1 [1m overdue, reminder 1/3] chat !room-a:");
		expect(sent[0]).toContain("I'll send the row counts once the import finishes.");
		expect(sent[0]).toContain("promise done <id>");

		expect(using((l) => l.item(1))).toMatchObject({
			state: "open",
			reminders: 1,
			next_remind: now - 30 * MINUTE + 6 * HOUR,
		});
	});

	it("keeps an item due when the inject fails, then delivers it once under the same key", () => {
		say("I'll send the row counts once the import finishes.");
		sweep();
		now += 5 * HOUR;
		writeFileSync(path.join(dir, "down"), "");
		expect(sweep()).toMatchObject({ remind: { sent: 0, failed: 1 } });
		now += 5 * MINUTE;
		expect(sweep()).toMatchObject({ remind: { sent: 0, failed: 1 } });
		expect(using((l) => l.item(1))).toMatchObject({ state: "open", reminders: 0 });
		rmSync(path.join(dir, "down"));
		now += 5 * MINUTE;
		expect(sweep()).toMatchObject({ remind: { sent: 1, failed: 0 } });
		expect(injected()).toHaveLength(1);

		const batches = using((l) =>
			l.db.prepare("SELECT key, state, tries, response FROM batch").all(),
		);

		expect(batches).toHaveLength(1);
		expect(batches[0]).toMatchObject({ state: "sent", tries: 3, response: "queued 1" });
	});

	it("does not queue twice when the hub took the prompt but the run died before recording it", () => {
		say("I'll send the row counts once the import finishes.");
		sweep();
		now += 5 * HOUR;
		sweep();

		// Put the store back to the moment before the answer was recorded.
		using((l) => {
			l.db.exec(
				"UPDATE batch SET state = 'pending'; UPDATE item SET reminders = 0, next_remind = 0; DELETE FROM meta WHERE k = 'last_promise_prompt'",
			);
		});

		now += 5 * MINUTE;
		expect(sweep()).toMatchObject({ remind: { sent: 1 } });
		expect(injected()).toHaveLength(1);

		expect(using((l) => l.db.prepare("SELECT response FROM batch").get())).toMatchObject({
			response: expect.stringContaining("already queued") as string,
		});

		expect(using((l) => l.item(1))).toMatchObject({ reminders: 1 });
	});

	it("caps a prompt, spaces prompts, backs off per promise and escalates after the last reminder", () => {
		for (let i = 0; i < 5; i += 1) {
			say(`I'll send report number ${String(i)} after the build.`);
		}

		sweep();
		now += 5 * HOUR;
		sweep();
		expect(injected()).toHaveLength(1);
		expect(injected()[0]?.match(/^#\d+ /gmu)).toHaveLength(3);
		now += 10 * MINUTE;
		sweep();
		expect(injected()).toHaveLength(1);
		now += HOUR;
		sweep();
		expect(injected()).toHaveLength(2);
		expect(injected()[1]?.match(/^#\d+ /gmu)).toEqual(["#4 ", "#5 "]);

		using((l) => {
			for (const id of [2, 3, 4, 5]) {
				l.closeItem(id, "done", "command", "sent");
			}
		});

		now += 6 * HOUR;
		sweep();
		expect(injected()[2]).toContain("reminder 2/3");
		now += 24 * HOUR;
		sweep();
		expect(injected()[3]).toContain("reminder 3/3");
		expect(using((l) => l.item(1))).toMatchObject({ state: "open", escalated: 1, reminders: 3 });
		now += 96 * HOUR;
		sweep();
		expect(injected()).toHaveLength(4);

		expect(statusLine(config.store, now)).toContain(
			"1 open promise(s), 1 overdue (1 out of reminders)",
		);
	});

	it("closes by command and by a delivering message in the same room only", () => {
		say("I'll mirror the calendar feed into the shared planner as busy blocks.");

		say("I'll mirror the calendar feed into the shared planner as busy blocks.", {
			room: "!room-b",
		});

		say("I'll send the row counts once the import finishes.");
		sweep();
		now += 10 * MINUTE;
		say("The calendar feed is live in the shared planner as busy blocks.", { ref: "$delivery" });
		sweep();

		expect(using((l) => l.item(1))).toMatchObject({
			state: "done",
			closed_by: "auto",
			evidence: "delivered by entry 5 $delivery",
		});

		expect(using((l) => l.item(2))).toMatchObject({ state: "open" });

		expect(using((l) => l.closeItem(3, "done", "command", "sent in $evt9"))).toMatchObject({
			state: "done",
			closed_by: "command",
			evidence: "sent in $evt9",
		});

		expect(() => using((l) => l.closeItem(3, "done", "command", ""))).toThrow("already done");
		now += 6 * HOUR;
		sweep();
		expect(injected()).toHaveLength(1);
		expect(injected()[0]?.match(/^#\d+ /gmu)).toEqual(["#2 "]);
	});

	it("does not close a message's promises on a delivery of only one of them", () => {
		say(
			"I'll mirror the calendar feed into the shared planner as busy blocks. I'll also send the row counts tonight.",
		);

		sweep();
		now += 10 * MINUTE;
		say("The calendar feed is live in the shared planner as busy blocks.");
		sweep();
		expect(using((l) => l.item(1))).toMatchObject({ state: "open" });
	});

	it("snoozes with a fresh set of reminders", () => {
		say("I'll send the row counts once the import finishes.");
		sweep();
		now += 5 * HOUR;
		sweep();
		using((l) => l.snooze(1, now + 2 * HOUR));
		now += HOUR;
		sweep();
		expect(injected()).toHaveLength(1);
		now += 61 * MINUTE;
		sweep();
		expect(injected()).toHaveLength(2);
		expect(injected()[1]).toContain("reminder 1/3");
	});

	it("fires a timed reminder once with its own prompt, even after a long outage", () => {
		using((l) =>
			l.addReminder(
				"water-check",
				now + HOUR,
				"Check the plant sensor and say nothing if it is fine.",
			),
		);

		sweep();
		expect(injected()).toEqual([]);
		// Three days with no sweep at all.
		now += 72 * HOUR;
		sweep();
		sweep();
		expect(injected()).toHaveLength(1);

		expect(injected()[0]).toMatch(
			/^water-check\|promise-ledger:[0-9a-f]{12}:1\|Check the plant sensor/u,
		);

		expect(using((l) => l.item(1))).toMatchObject({ state: "done", closed_by: "fired" });
	});

	it("sends nothing while paused and catches up after", () => {
		using((l) => l.addReminder("ping", now + MINUTE, "ping"));

		using((l) => {
			l.setMeta("paused", "1");
		});

		now += HOUR;
		sweep();
		expect(injected()).toEqual([]);

		using((l) => {
			l.setMeta("paused", "0");
		});

		sweep();
		expect(injected()).toHaveLength(1);
	});

	it("writes the vault record only for a promise that outlives its due time, then its outcome", () => {
		say("I'll send the quick one.", { ref: "$quick" });
		say("I'll send the row counts once the import finishes.", { ref: "$slow" });
		sweep();
		using((l) => l.closeItem(1, "done", "command", "sent"));
		now += 5 * HOUR;
		writeFileSync(path.join(dir, "vault-down"), "");
		expect(sweep()).toMatchObject({ recorded: 1, vault: { written: 0, retry: 1 } });
		expect(vaulted()).toEqual([]);
		rmSync(path.join(dir, "vault-down"));
		now += 6 * MINUTE;
		expect(sweep()).toMatchObject({ vault: { written: 1 } });
		using((l) => l.closeItem(2, "dropped", "command", "the import was cancelled"));
		sweep();

		const [record, outcome, ...rest] = vaulted();

		expect(rest).toEqual([]);

		expect(record).toMatch(
			/^remember --tier agent --topic Promises --direct Agent message in chat !room-a, event \$slow --quote I'll send the row counts once the import finishes\. promise [0-9a-f]{12}\/2: made .* still open past its due time/u,
		);

		expect(outcome).toMatch(
			/^remember --tier agent .* --replaces c-test0001 promise [0-9a-f]{12}\/2: dropped .*\(the import was cancelled\)/u,
		);

		expect(using((l) => l.item(2))).toMatchObject({ claim: "c-test0002" });
		expect(vaulted().join("\n")).not.toContain("quick");
	});

	it("gives up on a vault write the vault refuses, and keeps retrying one it cannot reach", () => {
		say("I'll send the row counts once the import finishes.");
		sweep();
		now += 5 * HOUR;
		script("vault", "echo refused >&2; exit 1");

		for (let i = 0; i < 6; i += 1) {
			sweep();
			now += 7 * HOUR;
		}

		expect(
			using((l) => l.db.prepare("SELECT state, tries, result FROM outbox").get()),
		).toMatchObject({ state: "rejected", tries: 5, result: "refused" });
	});

	it("lets only one sweep run at a time", () => {
		using((l) => {
			l.setMeta("lock", String(now));
		});

		expect(sweep()).toEqual({ skipped: "another sweep is running" });
		now += 16 * MINUTE;
		expect(sweep()).toHaveProperty("ingest");
	});

	it("adds one line to the session-start hook, and a broken store costs the hook nothing", () => {
		const hook = (store: string) =>
			execFileSync(
				process.execPath,
				["--no-warnings", fileURLToPath(new URL("sessionstart-objectives.ts", import.meta.url))],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PROMISE_STORE: store,
						OBJECTIVES_LEDGER: path.join(dir, "objectives.md"),
						TASK_OUTPUT_ROOTS: "",
					},
				},
			);

		writeFileSync(
			path.join(dir, "objectives.md"),
			"- **Widget rollout** · me · state: active · next: run the demo\n",
		);

		say("I'll send the row counts once the import finishes.");
		sweep();

		const context = (
			JSON.parse(hook(config.store)) as { hookSpecificOutput: { additionalContext: string } }
		).hookSpecificOutput.additionalContext;

		expect(context).toContain("Widget rollout");

		// The hook reads the real clock, which is long past this promise's due time.
		expect(context.split("\n").filter((l) => l.includes("Promise ledger:"))).toEqual([
			"Promise ledger: 1 open promise(s), 1 overdue (0 out of reminders), 0 timed reminder(s) scheduled. List them with `promise list`; close with `promise done|snooze|drop <id>`.",
		]);

		writeFileSync(path.join(dir, "garbage.sqlite"), "not a database");

		const broken = hook(path.join(dir, "garbage.sqlite"));

		expect(broken).toContain("Widget rollout");
		expect(broken).not.toContain("Promise ledger");
	});

	it("reports nothing at session start when there is no store", () => {
		expect(statusLine(path.join(dir, "absent.sqlite"), now)).toBe("");
		expect(existsSync(path.join(dir, "absent.sqlite"))).toBe(false);
	});
});
