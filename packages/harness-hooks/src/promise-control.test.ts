import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { control, parseControl } from "./promise-control.ts";
import { configFromEnv, Ledger } from "./promise-ledger.ts";

test("page controls persist changes without running a sweep or resuming the scheduler", () => {
	const root = mkdtempSync(path.join(tmpdir(), "promise-control-"));
	const jobs = path.join(root, "jobs.json");
	const scheduler = JSON.stringify({ jobs: [{ name: "promise-sweep", enabled: false }] });

	writeFileSync(jobs, scheduler);
	let injections = 0;
	const config = {
		...configFromEnv(),
		store: path.join(root, "ledger.sqlite"),
		history: path.join(root, "absent.sqlite"),
	};
	const ledger = new Ledger(config, {
		now: () => 1_000_000,
		inject: () => {
			injections++;

			return { ok: true, output: "" };
		},
		vault: () => {
			throw new Error("must not write vault from controls");
		},
	});

	try {
		const reminder = ledger.addReminder("proof", 999_000, "Synthetic reminder");

		expect(control(ledger, { action: "pause" }, jobs)).toMatchObject({
			paused: true,
			scheduler: "paused",
		});
		expect(control(ledger, { action: "resume" }, jobs)).toMatchObject({
			paused: false,
			scheduler: "paused",
		});
		expect(readFileSync(jobs, "utf8")).toBe(scheduler);
		control(ledger, { action: "snooze", id: reminder.id, hours: 24 }, jobs);
		expect(ledger.item(reminder.id)?.due).toBe(1_000_000 + 24 * 3_600_000);
		control(ledger, { action: "drop", id: reminder.id, reason: "No longer needed" }, jobs);
		expect(ledger.item(reminder.id)).toMatchObject({
			state: "dropped",
			evidence: "No longer needed",
		});
		expect(control(ledger, { action: "snapshot" }, jobs).items).toEqual([]);
		expect(injections).toBe(0);
	} finally {
		ledger.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	{ action: "sweep" },
	{ action: "drop", id: 1, reason: " " },
	{ action: "snooze", id: 1, hours: -1 },
	{ action: "drop", id: "1; rm -rf /", reason: "no" },
])("refuses invalid control before opening state: %j", (input) => {
	expect(() => parseControl(input)).toThrow();
});
