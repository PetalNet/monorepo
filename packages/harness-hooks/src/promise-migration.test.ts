import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { configFromEnv, Ledger, statusLine } from "./promise-ledger.ts";

it("migrates grouped legacy records and pending delivery keys without losing work or outcomes", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "promise-migration-"));
	const store = path.join(dir, "ledger.sqlite");
	const old = new DatabaseSync(store);

	old.exec(`
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO meta VALUES ('cursor', '100'), ('nonce', 'original');
CREATE TABLE item (
 id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
 escalated INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, due REAL NOT NULL, due_source TEXT NOT NULL DEFAULT '',
 room TEXT NOT NULL DEFAULT '', surface TEXT NOT NULL DEFAULT '', event_id TEXT NOT NULL DEFAULT '',
 entry_id INTEGER UNIQUE, pointer TEXT NOT NULL DEFAULT '', name TEXT UNIQUE,
 text TEXT NOT NULL, more TEXT NOT NULL DEFAULT '[]', reminders INTEGER NOT NULL DEFAULT 0,
 next_remind REAL NOT NULL DEFAULT 0, closed REAL, closed_by TEXT, evidence TEXT,
 recorded INTEGER NOT NULL DEFAULT 0, claim TEXT);
CREATE INDEX item_open ON item (state, due);
INSERT INTO item (id, kind, created, due, entry_id, text, more, reminders, recorded, claim)
 VALUES (7, 'promise', 1, 2, 40, 'I will send the chart.', '["I will send the table."]', 2, 1, 'c-chart');
INSERT INTO item (kind, created, due, entry_id, text, due_source) VALUES ('promise', 1, 2, 41, 'On it.', 'default');
INSERT INTO item (kind, created, due, name, text) VALUES ('reminder', 1, 2, 'alarm', 'Check the oven');
INSERT INTO item (kind, created, due, state, text, closed, closed_by, evidence)
 VALUES ('promise', 1, 2, 'dropped', 'I will send the preview.', 3, 'command', 'Cancelled by requester');
INSERT INTO item (kind, created, due, entry_id, text, due_source)
 VALUES ('promise', 1, 2, 42, 'I am checking the server tomorrow.', 'stated: tomorrow');
CREATE TABLE batch (
 id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, source TEXT NOT NULL, items TEXT NOT NULL,
 created REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending', tries INTEGER NOT NULL DEFAULT 0,
 last_try REAL, sent REAL, response TEXT NOT NULL DEFAULT '');
INSERT INTO batch (key, source, items, created) VALUES ('original-key', 'alarm', '[9]', 2);
CREATE TABLE outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER NOT NULL, op TEXT NOT NULL, created REAL NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0,
 result TEXT NOT NULL DEFAULT '');
INSERT INTO outbox (item, op, created) VALUES (7, 'record', 2);
`);

	old.close();
	const config = { ...configFromEnv(), store, history: path.join(dir, "absent.sqlite") };
	const delivered: string[] = [];
	const deps = {
		now: () => 1_000_000_000,
		inject: (_prompt: string, _source: string, key: string) => {
			delivered.push(key);

			return { ok: true, output: "already queued" };
		},
		vault: () => {
			throw new Error("unexpected vault call");
		},
	};

	try {
		expect(statusLine(store, deps.now())).toContain("3 open promise(s)");
		const ledger = new Ledger(config, deps);

		try {
			expect(ledger.meta("cursor")).toBe("100");

			expect(ledger.must(7)).toMatchObject({
				entry_id: 40,
				more: '["I will send the table."]',
				attention: "review",
				state: "open",
				claim: "c-chart",
				branch: null,
			});

			expect(ledger.must(8)).toMatchObject({ attention: "quiet", state: "open" });
			expect(ledger.must(11)).toMatchObject({ attention: "pending", state: "open" });

			expect(ledger.must(10)).toMatchObject({
				state: "dropped",
				evidence: "Cancelled by requester",
			});

			expect(ledger.db.prepare("SELECT count(*) AS n FROM outbox").get()?.["n"]).toBe(1);
			ledger.remind();
			expect(delivered[0]).toBe("original-key");
			expect(delivered).toHaveLength(2);
			expect(ledger.must(9)).toMatchObject({ state: "done", closed_by: "fired" });
		} finally {
			ledger.close();
		}

		const reopened = new Ledger(config, deps);

		try {
			expect(reopened.items("1 = 1")).toHaveLength(5);
			reopened.remind();
			expect(delivered).toHaveLength(2);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
