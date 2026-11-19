// The promise ledger: a local store of every deferred promise an agent makes in chat, plus plain timed reminders,
// and the sweep that keeps them from being silently dropped. One repeating job runs `sweep`:
//
//   ingest   read new outgoing messages from the chat hub's history (read-only, by cursor); a message that delivers
//            an open promise in its room closes it; a message that makes a promise gets an item with a due time
//   record   a promise that passes its due time still open is queued for the durable record (the vault)
//   remind   due reminders and overdue promises are queued into the agent's session through the inject command;
//            the key of every inject is stored before the command runs, so a crash or a repeated tick cannot queue
//            the same reminder twice
//   outbox   queued vault writes are sent, a few per run, and retried while the vault host is unreachable
//
// Nothing here calls a model or sends message text anywhere but the configured inject and vault commands.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { delivers } from "./promise-close.ts";
import { detect } from "./promise-detect.ts";
import { parseDue } from "./promise-due.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface Config {
	/** The ledger's own SQLite file. */
	store: string;
	/** The chat hub's history database, opened read-only. */
	history: string;
	timeZone: string;
	resetHour: number;
	/** Default time a promise gets when it states none. */
	graceMs: number;
	/** At most one promise prompt per this long; timed reminders are not limited. */
	promptEveryMs: number;
	/** Promises listed in one prompt. */
	promptCap: number;
	/**
	 * Wait after the first, second, ... delivered reminder of one promise. Its length bounds the
	 * reminders.
	 */
	backoffMs: number[];
	/** Vault topic the durable record is written under, in the `agent` tier. */
	vaultTopic: string;
	/** Hub surfaces whose outgoing rows are not messages to people (the terminal). */
	skipSurfaces: string[];
	/** Vault writes attempted per sweep. */
	vaultPerSweep: number;
}

export interface CommandResult {
	ok: boolean;
	/** What the command printed, trimmed. */
	output: string;
	/** For the vault: the host could not be reached, so retry; otherwise a refusal is final. */
	unreachable?: boolean;
}

export interface Deps {
	now: () => number;
	/** Queue `prompt` as a turn in the agent's session; `key` makes a repeat a no-op at the hub. */
	inject: (prompt: string, source: string, key: string) => CommandResult;
	/** Run the vault CLI with these arguments. */
	vault: (args: string[]) => CommandResult;
}

export interface Item {
	id: number;
	kind: "promise" | "reminder";
	state: "open" | "done" | "dropped";
	escalated: number;
	created: number;
	due: number;
	due_source: string;
	room: string;
	surface: string;
	event_id: string;
	entry_id: number | null;
	pointer: string;
	name: string | null;
	text: string;
	more: string;
	reminders: number;
	next_remind: number;
	closed: number | null;
	closed_by: string | null;
	evidence: string | null;
	recorded: number;
	claim: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('promise', 'reminder')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'dropped')),
  escalated INTEGER NOT NULL DEFAULT 0,
  created REAL NOT NULL, due REAL NOT NULL, due_source TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '', surface TEXT NOT NULL DEFAULT '', event_id TEXT NOT NULL DEFAULT '',
  entry_id INTEGER UNIQUE, pointer TEXT NOT NULL DEFAULT '', name TEXT UNIQUE,
  text TEXT NOT NULL, more TEXT NOT NULL DEFAULT '[]',
  reminders INTEGER NOT NULL DEFAULT 0, next_remind REAL NOT NULL DEFAULT 0,
  closed REAL, closed_by TEXT, evidence TEXT,
  recorded INTEGER NOT NULL DEFAULT 0, claim TEXT);
CREATE INDEX IF NOT EXISTS item_open ON item (state, due);
CREATE TABLE IF NOT EXISTS batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, source TEXT NOT NULL, items TEXT NOT NULL,
  created REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'void')),
  tries INTEGER NOT NULL DEFAULT 0, last_try REAL, sent REAL, response TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER NOT NULL, op TEXT NOT NULL CHECK (op IN ('record', 'outcome')),
  created REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'rejected')),
  tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '');
`;

function envOr(name: string, fallback: string) {
	const v = process.env[name];

	return v === undefined || v === "" ? fallback : v;
}

export function configFromEnv(): Config {
	const home = process.env["HOME"] ?? "";
	const hermes = envOr("HERMES_HOME", `${home}/.hermes`);

	return {
		store: envOr("PROMISE_STORE", `${home}/.local/share/promise-ledger/ledger.sqlite`),
		history: envOr("PROMISE_HISTORY_DB", `${hermes}/cc-link/history.db`),
		timeZone: envOr("PROMISE_TZ", Intl.DateTimeFormat().resolvedOptions().timeZone),
		resetHour: Number(envOr("PROMISE_RESET_HOUR", "4")),
		graceMs: Number(envOr("PROMISE_GRACE_MINUTES", "240")) * MINUTE,
		promptEveryMs: Number(envOr("PROMISE_PROMPT_EVERY_MINUTES", "60")) * MINUTE,
		promptCap: Number(envOr("PROMISE_PROMPT_CAP", "12")),
		backoffMs: envOr("PROMISE_BACKOFF_HOURS", "6,24,48")
			.split(",")
			.map((h) => Number(h) * HOUR),
		vaultTopic: envOr("PROMISE_VAULT_TOPIC", "Promises"),
		skipSurfaces: envOr("PROMISE_SKIP_SURFACES", "cli").split(","),
		vaultPerSweep: Number(envOr("PROMISE_VAULT_PER_SWEEP", "2")),
	};
}

function run(command: string, args: string[], input: string | undefined, timeoutMs: number) {
	const r = spawnSync(command, args, { input, encoding: "utf8", timeout: timeoutMs });

	return { status: r.status, output: `${r.stdout}${r.stderr}`.trim() || (r.error?.message ?? "") };
}

export function depsFromEnv(): Deps {
	const hermes = envOr("HERMES_HOME", `${process.env["HOME"] ?? ""}/.hermes`);
	const injectCommand = envOr(
		"PROMISE_INJECT",
		`${hermes}/plugins/hermes-cc-link/bin/cc-link-inject`,
	);
	const vaultCommand = envOr("PROMISE_VAULT", "vault-engine");

	return {
		now: () => Date.now(),
		inject: (prompt, source, key) => {
			const r = run(injectCommand, ["--source", source, "--key", key], prompt, 30_000);

			return { ok: r.status === 0, output: r.output };
		},
		vault: (args) => {
			const r = run(vaultCommand, args, undefined, 30_000);

			// ssh exits 255 when it cannot connect; a timeout leaves no status.
			return {
				ok: r.status === 0,
				output: r.output,
				unreachable: r.status === 255 || r.status === null,
			};
		},
	};
}

export class Ledger {
	readonly db: DatabaseSync;
	readonly config: Config;
	readonly deps: Deps;

	constructor(config: Config, deps: Deps) {
		this.config = config;
		this.deps = deps;
		mkdirSync(path.dirname(config.store), { recursive: true });
		this.db = new DatabaseSync(config.store);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA);

		// Part of every inject key. The hub remembers keys forever, so a recreated store must not reuse an old one.
		this.db
			.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('nonce', ?)")
			.run(randomBytes(6).toString("hex"));
	}

	close() {
		this.db.close();
	}

	meta(key: string): string | undefined {
		const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(key);

		return row === undefined ? undefined : String(row["v"]);
	}

	setMeta(key: string, value: string) {
		this.db
			.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
			.run(key, value);
	}

	item(id: number): Item | undefined {
		return this.db.prepare("SELECT * FROM item WHERE id = ?").get(id) as Item | undefined;
	}

	must(id: number): Item {
		const item = this.item(id);

		if (!item) {
			throw new Error(`no item ${String(id)}`);
		}

		return item;
	}

	items(where = "state = 'open'", ...params: (string | number)[]): Item[] {
		return this.db
			.prepare(`SELECT * FROM item WHERE ${where} ORDER BY due, id`)
			.all(...params) as unknown as Item[];
	}

	/** Adds a timed reminder: at `due` its prompt is queued into the session once. */
	addReminder(name: string, due: number, prompt: string): Item {
		const r = this.db
			.prepare(
				"INSERT INTO item (kind, created, due, due_source, name, text) VALUES ('reminder', ?, ?, 'stated', ?, ?)",
			)
			.run(this.deps.now(), due, name, prompt);

		return this.must(Number(r.lastInsertRowid));
	}

	/** Closes an open item. A promise already in the durable record gets its outcome queued too. */
	closeItem(id: number, state: "done" | "dropped", by: string, evidence: string): Item {
		const item = this.item(id);

		if (!item) {
			throw new Error(`no item ${String(id)}`);
		}

		if (item.state !== "open") {
			throw new Error(`item ${String(id)} is already ${item.state}`);
		}

		const now = this.deps.now();

		this.db
			.prepare("UPDATE item SET state = ?, closed = ?, closed_by = ?, evidence = ? WHERE id = ?")
			.run(state, now, by, evidence, id);

		if (item.recorded) {
			this.db
				.prepare("INSERT INTO outbox (item, op, created) VALUES (?, 'outcome', ?)")
				.run(id, now);
		}

		return this.must(id);
	}

	/** Moves an open item's due time and gives it a fresh set of reminders. */
	snooze(id: number, due: number): Item {
		const item = this.item(id);

		if (item?.state !== "open") {
			throw new Error(`no open item ${String(id)}`);
		}

		this.db
			.prepare(
				"UPDATE item SET due = ?, due_source = 'snoozed', reminders = 0, next_remind = 0, escalated = 0 WHERE id = ?",
			)
			.run(due, id);

		return this.must(id);
	}

	/** Reads new outgoing messages: closes what they deliver, records what they promise. */
	ingest(limit = 500): { read: number; added: number; closed: number } {
		const { config } = this;
		const counts = { read: 0, added: 0, closed: 0 };

		if (!existsSync(config.history)) {
			return counts;
		}

		const history = new DatabaseSync(config.history, { readOnly: true });

		try {
			const stored = this.meta("cursor");

			if (stored === undefined) {
				// A new ledger starts from now: old messages would all arrive overdue at once.
				const top = history.prepare("SELECT COALESCE(MAX(id), 0) AS top FROM entry").get();

				this.setMeta("cursor", String(top?.["top"] ?? 0));

				return counts;
			}

			const rows = history
				.prepare(
					"SELECT id, ts, surface, channel, branch, text, ref FROM entry WHERE id > ? AND direction = 'out' ORDER BY id LIMIT ?",
				)
				.all(Number(stored), limit);
			const before = history.prepare(
				"SELECT ref FROM entry WHERE id < ? AND direction = 'in' AND channel = ? AND branch = ? AND ref != '' ORDER BY id DESC LIMIT 1",
			);

			for (const row of rows) {
				const id = Number(row["id"]);
				const at = Number(row["ts"]) * 1000;
				const surface = String(row["surface"]);
				const room = String(row["channel"]);
				const text = String(row["text"]);

				counts.read += 1;
				this.db.exec("BEGIN IMMEDIATE");

				try {
					if (!config.skipSurfaces.includes(surface)) {
						counts.closed += this.closeDelivered(surface, room, text, at, id, String(row["ref"]));

						const found = detect(text);
						// The line a reminder shows: an "I'll ..." sentence if there is one, else a delivery, else whatever was found.
						const first =
							found.find((f) => f.kind === "future") ??
							found.find((f) => f.kind === "delivery") ??
							found[0];

						if (first) {
							let due: { at: number; stated: string } | undefined;

							for (const f of found) {
								const d = parseDue(f.sentence, at, config);

								if (d && (!due || d.at > due.at)) {
									due = d;
								}
							}

							// The card of the conversation a message belongs to is keyed by the incoming event that began it.
							const prompt = before.get(id, room, String(row["branch"]));
							const added = this.db
								.prepare(
									"INSERT OR IGNORE INTO item (kind, created, due, due_source, room, surface, event_id, entry_id, pointer, text, more) VALUES ('promise', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
								)
								.run(
									at,
									due?.at ?? at + config.graceMs,
									due ? `stated: ${due.stated}` : "default",
									room,
									surface,
									String(row["ref"]),
									id,
									prompt ? `event:${String(prompt["ref"])}` : "",
									first.sentence,
									JSON.stringify(found.filter((f) => f !== first).map((f) => f.sentence)),
								);

							counts.added += Number(added.changes);
						}
					}

					this.setMeta("cursor", String(id));
					this.db.exec("COMMIT");
				} catch (error) {
					this.db.exec("ROLLBACK");

					throw error;
				}
			}
		} finally {
			history.close();
		}

		return counts;
	}

	// A message delivers a promise only when it delivers every promise its message made, and only after a minute:
	// a message sent seconds later is the same burst still talking.
	private closeDelivered(
		surface: string,
		room: string,
		text: string,
		at: number,
		entry: number,
		ref: string,
	): number {
		let closed = 0;

		for (const item of this.items(
			"state = 'open' AND kind = 'promise' AND surface = ? AND room = ? AND created < ?",
			surface,
			room,
			at - MINUTE,
		)) {
			const all = [item.text, ...(JSON.parse(item.more) as string[])];
			const by = all.map((sentence) => delivers(sentence, text));

			if (by.every((sentence) => sentence !== undefined)) {
				this.closeItem(
					item.id,
					"done",
					"auto",
					`delivered by entry ${String(entry)}${ref ? ` ${ref}` : ""}`,
				);

				closed += 1;
			}
		}

		return closed;
	}

	/** Queues the durable record for every promise that has passed its due time still open. */
	recordOverdue(): number {
		const now = this.deps.now();
		const due = this.items(
			"state = 'open' AND kind = 'promise' AND recorded = 0 AND due <= ?",
			now,
		);

		for (const item of due) {
			this.db.prepare("UPDATE item SET recorded = 1 WHERE id = ?").run(item.id);

			this.db
				.prepare("INSERT INTO outbox (item, op, created) VALUES (?, 'record', ?)")
				.run(item.id, now);
		}

		return due.length;
	}

	private attempt(batch: number, prompt: string): CommandResult {
		const row = this.db.prepare("SELECT key, source FROM batch WHERE id = ?").get(batch);
		const now = this.deps.now();
		let result: CommandResult;

		try {
			result = this.deps.inject(prompt, String(row?.["source"]), String(row?.["key"]));
		} catch (error) {
			result = { ok: false, output: String(error) };
		}

		this.db
			.prepare(
				"UPDATE batch SET tries = tries + 1, last_try = ?, response = ?, state = ?, sent = ? WHERE id = ?",
			)
			.run(
				now,
				result.output.slice(0, 500),
				result.ok ? "sent" : "pending",
				result.ok ? now : null,
				batch,
			);

		return result;
	}

	private afterSent(items: Item[]) {
		const now = this.deps.now();
		const { backoffMs } = this.config;

		for (const item of items) {
			if (item.kind === "reminder") {
				this.closeItem(item.id, "done", "fired", "queued into the session");

				continue;
			}

			const reminders = item.reminders + 1;
			const wait = backoffMs[reminders - 1];

			// Out of reminders: the promise stays open and listed, marked escalated, and is never reminded again.
			this.db
				.prepare("UPDATE item SET reminders = ?, next_remind = ?, escalated = ? WHERE id = ?")
				.run(reminders, now + (wait ?? 0), wait === undefined ? 1 : 0, item.id);
		}
	}

	private promptFor(items: Item[]): string {
		const [only] = items;

		if (only?.kind === "reminder") {
			return only.text;
		}

		const now = this.deps.now();
		const lines = items.map((item) => {
			const total = this.config.backoffMs.length + 1;
			const where = item.room ? `${item.surface} ${item.room}` : item.surface;
			// One way back to the conversation: its card when there is one, else the sent message itself.
			const event = item.event_id ? ` sent: ${item.event_id}` : ` entry: ${String(item.entry_id)}`;
			const pointer = item.pointer ? ` unfold: ${item.pointer}` : event;
			const more = (JSON.parse(item.more) as string[]).length;

			return `#${String(item.id)} [${span(now - item.due)} overdue, reminder ${String(item.reminders + 1)}/${String(total)}] ${where}: "${clip(item.text, 160)}"${more ? ` (+${String(more)} more in that message)` : ""}${pointer}`;
		});

		return [
			`[promise-ledger] ${String(items.length)} promise(s) you made are past due and still open. This goes only to you: post nothing about it to a room unless a promise itself is owed there.`,
			"For each: if it is already delivered, `promise done <id> <evidence>`; if it is owed, deliver it, then close it; if it needs longer, `promise snooze <id> <when>`; if it no longer applies, `promise drop <id> <reason>`. Ids may be comma-separated. `promise list` shows everything open.",
			...lines,
		].join("\n");
	}

	/**
	 * Queues due reminders and overdue promises into the session. Returns what was sent and what
	 * failed.
	 */
	remind(): { sent: number; failed: number; escalated: number } {
		const { config } = this;
		const now = this.deps.now();
		const counts = { sent: 0, failed: 0, escalated: 0 };

		if (this.meta("paused") === "1") {
			return counts;
		}

		const openIn = (ids: number[]) =>
			ids.flatMap((id) => this.items("id = ? AND state = 'open'", id));
		const send = (batch: number, items: Item[]) => {
			const result = this.attempt(batch, this.promptFor(items));

			if (result.ok) {
				this.afterSent(items);
				counts.sent += 1;

				if (items[0]?.kind === "promise") {
					this.setMeta("last_promise_prompt", String(now));
				}

				counts.escalated += items.filter(
					(i) => i.kind === "promise" && i.reminders + 1 > config.backoffMs.length,
				).length;
			} else {
				counts.failed += 1;
			}

			return result.ok;
		};

		// An inject that was recorded but not confirmed goes again under its own key before anything new.
		for (const row of this.db
			.prepare("SELECT id, items FROM batch WHERE state = 'pending' ORDER BY id")
			.all()) {
			const items = openIn(JSON.parse(String(row["items"])) as number[]);

			if (items.length === 0) {
				this.db.prepare("UPDATE batch SET state = 'void' WHERE id = ?").run(Number(row["id"]));
			} else if (!send(Number(row["id"]), items)) {
				return counts;
			}
		}

		const create = (source: string, items: Item[]) => {
			const r = this.db
				.prepare("INSERT INTO batch (key, source, items, created) VALUES ('', ?, ?, ?)")
				.run(source, JSON.stringify(items.map((i) => i.id)), now);
			const id = Number(r.lastInsertRowid);

			this.db
				.prepare("UPDATE batch SET key = ? WHERE id = ?")
				.run(`promise-ledger:${this.meta("nonce") ?? ""}:${String(id)}`, id);

			return id;
		};

		for (const reminder of this.items("state = 'open' AND kind = 'reminder' AND due <= ?", now)) {
			if (!send(create(reminder.name ?? "reminder", [reminder]), [reminder])) {
				return counts;
			}
		}

		const last = Number(this.meta("last_promise_prompt") ?? 0);

		if (now - last < config.promptEveryMs) {
			return counts;
		}

		const overdue = this.items(
			"state = 'open' AND kind = 'promise' AND escalated = 0 AND due <= ? AND next_remind <= ?",
			now,
			now,
		).slice(0, config.promptCap);

		if (overdue.length > 0) {
			send(create("promise-ledger", overdue), overdue);
		}

		return counts;
	}

	private vaultArgs(item: Item, op: "record" | "outcome"): string[] | undefined {
		const tag = `promise ${this.meta("nonce") ?? ""}/${String(item.id)}`;
		const day = (at: number) => new Date(at).toISOString().slice(0, 16);
		const title = `Agent message in ${item.surface} ${item.room || "-"}, event ${item.event_id || `entry ${String(item.entry_id)}`}`;
		const base = [
			"remember",
			"--tier",
			"agent",
			"--topic",
			this.config.vaultTopic,
			"--direct",
			title,
			"--quote",
			item.text,
		];

		if (op === "record") {
			return [
				...base,
				`${tag}: made ${day(item.created)}Z, still open past its due time ${day(item.due)}Z: ${clip(item.text, 200)}`,
			];
		}

		if (!item.claim) {
			return undefined;
		}

		const how =
			item.closed_by === "auto"
				? "closed automatically"
				: item.state === "dropped"
					? "dropped"
					: "closed as done";

		return [
			...base,
			"--replaces",
			item.claim,
			`${tag}: ${how} ${day(item.closed ?? 0)}Z (${clip(item.evidence ?? "", 200)}): ${clip(item.text, 200)}`,
		];
	}

	/**
	 * Sends queued vault writes, oldest first. A write the vault host could not take is retried
	 * later.
	 */
	drainOutbox(): { written: number; retry: number; rejected: number } {
		const counts = { written: 0, retry: 0, rejected: 0 };
		const now = this.deps.now();
		const rows = this.db
			.prepare(
				"SELECT id, item, op, tries FROM outbox WHERE state = 'pending' AND next_try <= ? ORDER BY id LIMIT ?",
			)
			.all(now, this.config.vaultPerSweep);
		const finish = (id: number, state: string, result: string) =>
			this.db
				.prepare("UPDATE outbox SET state = ?, result = ?, tries = tries + 1 WHERE id = ?")
				.run(state, result.slice(0, 500), id);

		for (const row of rows) {
			const id = Number(row["id"]);
			const item = this.item(Number(row["item"]));
			const op = String(row["op"]) as "record" | "outcome";
			const tries = Number(row["tries"]);

			if (!item) {
				finish(id, "rejected", "item gone");

				continue;
			}

			const args = this.vaultArgs(item, op);

			if (!args) {
				// The outcome replaces the record's claim, so it waits for the record; if the record was refused, so is this.
				const record = this.db
					.prepare("SELECT state FROM outbox WHERE item = ? AND op = 'record' ORDER BY id DESC")
					.get(item.id);

				if (record?.["state"] === "pending") {
					this.db.prepare("UPDATE outbox SET next_try = ? WHERE id = ?").run(now + MINUTE, id);
				} else {
					finish(id, "rejected", "no record claim to replace");
					counts.rejected += 1;
				}

				continue;
			}

			let result: CommandResult;

			try {
				result = this.deps.vault(args);
			} catch (error) {
				result = { ok: false, output: String(error), unreachable: true };
			}

			const claim = /"id"\s*:\s*"(c-[^"]+)"/u.exec(result.output)?.[1];

			if (result.ok && claim) {
				finish(id, "done", claim);
				this.db.prepare("UPDATE item SET claim = ? WHERE id = ?").run(claim, item.id);
				counts.written += 1;
			} else if (result.unreachable || tries < 4) {
				// Unreachable: keep trying, at most every six hours. Refused: five tries, then final.
				this.db
					.prepare("UPDATE outbox SET tries = tries + 1, next_try = ?, result = ? WHERE id = ?")
					.run(now + Math.min(5 * MINUTE * 2 ** tries, 6 * HOUR), result.output.slice(0, 500), id);

				counts.retry += 1;
			} else {
				finish(id, "rejected", result.output);
				counts.rejected += 1;
			}
		}

		return counts;
	}

	/** One run of everything, under a lock so a manual sweep and the scheduled one cannot overlap. */
	sweep() {
		const now = this.deps.now();

		this.db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('lock', '0')").run();

		// One statement takes the lock. A lock older than fifteen minutes belongs to a run that died.
		const taken = this.db
			.prepare("UPDATE meta SET v = ? WHERE k = 'lock' AND CAST(v AS REAL) < ?")
			.run(String(now), now - 15 * MINUTE);

		if (Number(taken.changes) === 0) {
			return { skipped: "another sweep is running" };
		}

		try {
			const ingest = this.ingest();
			const recorded = this.recordOverdue();
			const remind = this.remind();
			const vault = this.drainOutbox();
			const result = { at: new Date(now).toISOString(), ingest, recorded, remind, vault };

			this.setMeta("last_sweep", JSON.stringify(result));

			return result;
		} finally {
			this.setMeta("lock", "0");
		}
	}
}

export function clip(text: string, max: number) {
	const one = text.replaceAll(/\s+/gu, " ").trim();

	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A span of time in the two largest units: "3d 4h", "2h 10m", "5m". */
export function span(ms: number) {
	const minutes = Math.max(0, Math.round(ms / MINUTE));
	const d = Math.floor(minutes / 1440);
	const h = Math.floor((minutes % 1440) / 60);
	const m = minutes % 60;

	return d ? `${String(d)}d ${String(h)}h` : h ? `${String(h)}h ${String(m)}m` : `${String(m)}m`;
}

/**
 * The one line a session start shows, read without creating or changing the store. Empty when there
 * is no store.
 */
export function statusLine(store: string, now: number): string {
	if (!existsSync(store)) {
		return "";
	}

	const db = new DatabaseSync(store, { readOnly: true });

	try {
		const row = db
			.prepare(
				`SELECT
           COALESCE(SUM(kind = 'promise'), 0) AS open,
           COALESCE(SUM(kind = 'promise' AND due <= ?), 0) AS overdue,
           COALESCE(SUM(kind = 'promise' AND escalated = 1), 0) AS escalated,
           COALESCE(SUM(kind = 'reminder'), 0) AS reminders
         FROM item WHERE state = 'open'`,
			)
			.get(now);
		const n = (key: string) => String(row?.[key] ?? 0);

		return `Promise ledger: ${n("open")} open promise(s), ${n("overdue")} overdue (${n("escalated")} out of reminders), ${n("reminders")} timed reminder(s) scheduled. List them with \`promise list\`; close with \`promise done|snooze|drop <id>\`.`;
	} finally {
		db.close();
	}
}
