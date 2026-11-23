// The promise ledger: a local store of every deferred promise an agent makes in chat, plus plain timed reminders,
// and the sweep that keeps them from being silently dropped. One repeating job runs `sweep`:
//
//   ingest   read new outgoing messages from the chat hub's history (read-only, by cursor); a message that delivers
//            an open promise in its branch can close it; each promising sentence gets its own item
//   record   deferred promises past due are queued for the durable record (the vault); progress stays local
//   remind   timed reminders and one reconciliation prompt per deferred promise use the inject command;
//            the key of every inject is stored before the command runs, so a crash or a repeated tick cannot queue
//            the same reminder twice while the hub retains that key
//   outbox   queued vault writes are sent, a few per run, and retried while the vault host is unreachable
//
// Nothing here calls a model or sends message text anywhere but the configured inject and vault commands.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { messageSource, tagMessage } from "./message-source.ts";
import { updateAcceptance } from "./promise-acceptance.ts";
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
	part: number;
	branch: string | null;
	attention: "pending" | "review" | "quiet";
	generation: number;
	changed: number;
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
  entry_id INTEGER, part INTEGER NOT NULL DEFAULT 0, branch TEXT,
  attention TEXT NOT NULL DEFAULT 'pending' CHECK (attention IN ('pending', 'review', 'quiet')),
  generation INTEGER NOT NULL DEFAULT 0, changed REAL NOT NULL DEFAULT 0,
  pointer TEXT NOT NULL DEFAULT '', name TEXT UNIQUE,
  text TEXT NOT NULL, more TEXT NOT NULL DEFAULT '[]',
  reminders INTEGER NOT NULL DEFAULT 0, next_remind REAL NOT NULL DEFAULT 0,
  closed REAL, closed_by TEXT, evidence TEXT,
  recorded INTEGER NOT NULL DEFAULT 0, claim TEXT, UNIQUE (entry_id, part));
CREATE INDEX IF NOT EXISTS item_open ON item (state, due);
CREATE TABLE IF NOT EXISTS acceptance (item INTEGER PRIMARY KEY, record TEXT NOT NULL);
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
		this.migrate();

		// A recreated store must not reuse keys still retained by the hub.
		this.db
			.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('nonce', ?)")
			.run(randomBytes(6).toString("hex"));
	}

	private migrate() {
		if (
			this.db
				.prepare("PRAGMA table_info(item)")
				.all()
				.some((c) => c["name"] === "part")
		) {
			return;
		}

		this.atomic(() => {
			this.db.exec("ALTER TABLE item RENAME TO old_item; DROP INDEX item_open;");
			this.db.exec(SCHEMA);

			const columns = this.db
				.prepare("PRAGMA table_info(old_item)")
				.all()
				.map((c) => String(c["name"]));

			this.db.exec(
				`INSERT INTO item (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM old_item`,
			);

			for (const item of this.items("kind = 'promise'")) {
				const found = detect([item.text, ...(JSON.parse(item.more) as string[])].join("\n"));
				const quiet =
					item.due_source === "default" &&
					found.length > 0 &&
					found.every((p) => p.kind === "working");

				this.db
					.prepare("UPDATE item SET attention = ? WHERE id = ?")
					.run(
						quiet ? "quiet" : item.reminders > 0 || item.escalated ? "review" : "pending",
						item.id,
					);
			}

			this.db.exec("DROP TABLE old_item");
		});
	}

	close() {
		this.db.close();
	}

	acceptance(id: number) {
		this.must(id);
		const row = this.db.prepare("SELECT record FROM acceptance WHERE item = ?").get(id);
		return typeof row?.["record"] === "string"
			? updateAcceptance(null, JSON.parse(row["record"]))
			: null;
	}

	setAcceptance(id: number, patch: unknown) {
		return this.atomic(() => {
			const item = this.must(id);
			if (item.kind !== "promise" || item.state !== "open") {
				throw new Error("acceptance belongs to an open promise");
			}
			const next = updateAcceptance(this.acceptance(id), patch);
			this.db
				.prepare(
					"INSERT INTO acceptance (item, record) VALUES (?, ?) ON CONFLICT(item) DO UPDATE SET record = excluded.record",
				)
				.run(id, JSON.stringify(next));
			return next;
		});
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
		const acceptance = this.acceptance(id);
		if (
			state === "done" &&
			acceptance &&
			Object.values(acceptance.checks).some((check) => check === null)
		) {
			throw new Error(`item ${String(id)} still has unresolved acceptance checks`);
		}

		const now = this.deps.now();

		this.db
			.prepare(
				"UPDATE item SET state = ?, closed = ?, closed_by = ?, evidence = ?, generation = generation + 1, changed = ? WHERE id = ?",
			)
			.run(state, now, by, evidence, now, id);

		if (item.recorded) {
			this.db
				.prepare("INSERT INTO outbox (item, op, created) VALUES (?, 'outcome', ?)")
				.run(id, now);
		}

		return this.must(id);
	}

	/** Reconciles selected items together, without partially applying an invalid selection. */
	reconcile(ids: number[], state: "done" | "dropped", evidence: string): Item[] {
		if (!evidence.trim()) {
			throw new Error(`${state} needs evidence or a reason`);
		}

		return this.atomic(() =>
			[...new Set(ids)].map((id) => this.closeItem(id, state, "command", evidence)),
		);
	}

	/** Reopens a closed item, for a close that was wrong. It is due at once. */
	reopen(id: number): Item {
		return this.atomic(() => {
			const item = this.must(id);

			if (item.state === "open") {
				throw new Error(`item ${String(id)} is already open`);
			}
			const acceptance = this.acceptance(id);
			if (acceptance) {
				acceptance.checks = Object.fromEntries(
					Object.keys(acceptance.checks).map((check) => [check, null]),
				);
				this.db
					.prepare("UPDATE acceptance SET record = ? WHERE item = ?")
					.run(JSON.stringify(acceptance), id);
			}

			const now = this.deps.now();

			this.db
				.prepare(
					"UPDATE item SET state = 'open', closed = NULL, closed_by = NULL, evidence = NULL, due = ?, due_source = 'reopened', attention = 'pending', reminders = 0, escalated = 0, next_remind = 0, generation = generation + 1, changed = ? WHERE id = ?",
				)
				.run(now, now, id);

			if (item.recorded) {
				this.db
					.prepare("INSERT INTO outbox (item, op, created) VALUES (?, 'outcome', ?)")
					.run(id, now);
			}

			return this.must(id);
		});
	}

	/** Moves an open item's due time and explicitly requests one more prompt. */
	snooze(id: number, due: number): Item {
		const item = this.item(id);

		if (item?.state !== "open") {
			throw new Error(`no open item ${String(id)}`);
		}

		this.db
			.prepare(
				"UPDATE item SET due = ?, due_source = 'snoozed', reminders = 0, next_remind = 0, escalated = 0, attention = 'pending', generation = generation + 1, changed = ? WHERE id = ?",
			)
			.run(due, this.deps.now(), id);

		return this.must(id);
	}

	/**
	 * Explicit local backfill. Repeated replays keep the same entry/part identities. No notifications
	 * are sent.
	 */
	replay(afterEntry: number): { read: number; added: number; closed: number } {
		if (!Number.isSafeInteger(afterEntry) || afterEntry < 0) {
			throw new Error("replay needs a nonnegative history entry id (0 for all history)");
		}

		const result = this.locked(() => {
			const cursor = Number(this.meta("cursor") ?? 0);

			this.setMeta("cursor", String(afterEntry));
			const total = { read: 0, added: 0, closed: 0 };

			try {
				let counts;

				do {
					counts = this.ingest();
					total.read += counts.read;
					total.added += counts.added;
					total.closed += counts.closed;
				} while (counts.read === 500);

				return total;
			} finally {
				this.setMeta("cursor", String(Math.max(cursor, Number(this.meta("cursor") ?? 0))));
			}
		});

		if ("skipped" in result) {
			throw new Error(result.skipped);
		}

		return result;
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

				this.db
					.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('cursor', ?)")
					.run(String(top?.["top"] ?? 0));

				return counts;
			}

			const rows = history
				.prepare(
					"SELECT id, ts, surface, channel, branch, text, ref FROM entry WHERE id > ? AND direction = 'out' ORDER BY id LIMIT ?",
				)
				.all(Number(stored), limit);
			const before = history.prepare(
				"SELECT ref, text FROM entry WHERE id < ? AND direction = 'in' AND surface = ? AND channel = ? AND branch = ? AND ref != '' ORDER BY id DESC",
			);

			for (const row of rows) {
				const id = Number(row["id"]);
				const at = Number(row["ts"]) * 1000;
				const surface = String(row["surface"]);
				const room = String(row["channel"]);
				const text = String(row["text"]);
				const branch = String(row["branch"]);
				const prompt = Iterator.from(before.iterate(id, surface, room, branch)).find((entry) => {
					const source = messageSource(String(entry["text"]), "unknown");
					return source !== "reminder" && source !== "automated-notification";
				});
				const pointer = prompt ? `event:${String(prompt["ref"])}` : "";

				counts.read += 1;
				this.db.exec("BEGIN IMMEDIATE");

				try {
					if (!config.skipSurfaces.includes(surface)) {
						counts.closed += this.closeDelivered(
							surface,
							room,
							branch,
							pointer,
							text,
							at,
							id,
							String(row["ref"]),
						);

						const found = detect(text);

						for (const [part, promise] of found.entries()) {
							const due = parseDue(promise.sentence, at, config);
							const added = this.db
								.prepare(
									"INSERT OR IGNORE INTO item (kind, created, due, due_source, room, surface, event_id, entry_id, part, branch, pointer, text, attention) SELECT 'promise', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM item WHERE entry_id = ? AND branch IS NULL)",
								)
								.run(
									at,
									due?.at ?? at + config.graceMs,
									due ? `stated: ${due.stated}` : "default",
									room,
									surface,
									String(row["ref"]),
									id,
									part,
									branch,
									pointer,
									promise.sentence,
									promise.kind === "working" && !due ? "quiet" : "pending",
									id,
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

	// Legacy grouped records lack a reliable branch and stay open for explicit reconciliation.
	private closeDelivered(
		surface: string,
		room: string,
		branch: string,
		pointer: string,
		text: string,
		at: number,
		entry: number,
		ref: string,
	): number {
		let closed = 0;
		const matches: { item: Item; evidence: string }[] = [];

		for (const item of this.items(
			"state = 'open' AND kind = 'promise' AND surface = ? AND room = ? AND branch = ? AND created <= ? AND changed <= ? AND entry_id < ? AND id NOT IN (SELECT item FROM acceptance)",
			surface,
			room,
			branch,
			at,
			at,
			entry,
		)) {
			const all = [item.text, ...(JSON.parse(item.more) as string[])];
			const by = all.map((sentence) =>
				delivers(sentence, text, { sameThread: pointer !== "" && pointer === item.pointer }),
			);

			if (by.every((sentence) => sentence !== undefined)) {
				matches.push({ item, evidence: by.join("\n") });
			}
		}

		for (const { item, evidence } of matches) {
			// One report cannot distinguish two outstanding obligations with the same subject.
			if (matches.filter((match) => match.evidence === evidence).length === 1) {
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

	/**
	 * Queues the durable record for overdue deferred work; quiet progress remains in the local
	 * ledger.
	 */
	recordOverdue(): number {
		const now = this.deps.now();
		const due = this.items(
			"state = 'open' AND kind = 'promise' AND attention != 'quiet' AND recorded = 0 AND due <= ?",
			now,
		);

		this.atomic(() => {
			for (const item of due) {
				this.db.prepare("UPDATE item SET recorded = 1 WHERE id = ?").run(item.id);

				this.db
					.prepare("INSERT INTO outbox (item, op, created) VALUES (?, 'record', ?)")
					.run(item.id, now);
			}
		});

		return due.length;
	}

	private attempt(batch: number, prompt: string): CommandResult {
		const row = this.db.prepare("SELECT key, source FROM batch WHERE id = ?").get(batch);

		try {
			return this.deps.inject(prompt, String(row?.["source"]), String(row?.["key"]));
		} catch (error) {
			return { ok: false, output: String(error) };
		}
	}

	/** Runs `body` as one transaction: all of it is stored, or none. */
	private atomic<T>(body: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");

		try {
			const value = body();

			this.db.exec("COMMIT");

			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");

			throw error;
		}
	}

	private afterSent(items: Item[]) {
		for (const item of items) {
			const current = this.must(item.id);

			if (current.state !== "open" || current.generation !== item.generation) {
				continue;
			}

			if (item.kind === "reminder") {
				this.closeItem(item.id, "done", "fired", "queued into the session");

				continue;
			}

			this.db
				.prepare(
					"UPDATE item SET reminders = reminders + 1, attention = 'review', escalated = 1 WHERE id = ?",
				)
				.run(item.id);
		}
	}

	private promptFor(items: Item[]): string {
		const [only] = items;

		if (only?.kind === "reminder") {
			return tagMessage("reminder", only.text);
		}

		const now = this.deps.now();
		const lines = items.map((item) => {
			const where = item.room ? `${item.surface} ${item.room}` : item.surface;
			// One way back to the conversation: its card when there is one, else the sent message itself.
			const event = item.event_id ? ` sent: ${item.event_id}` : ` entry: ${String(item.entry_id)}`;
			const pointer = item.pointer ? ` unfold: ${item.pointer}` : event;
			const more = (JSON.parse(item.more) as string[]).length;

			return `#${String(item.id)} [${span(now - item.due)} overdue, reconcile once] ${where}: "${clip(item.text, 160)}"${more ? ` (+${String(more)} more in that legacy message)` : ""}${pointer}`;
		});

		return tagMessage(
			"reminder",
			[
				`[promise-ledger] ${String(items.length)} promise(s) you made are past due and still open. This goes only to you: post nothing about it to a room unless a promise itself is owed there.`,
				"For each: if it is already delivered, `promise done <id> <evidence>`; if it is owed, deliver it, then close it; if it needs longer, `promise snooze <id> <when>`; if it no longer applies, `promise drop <id> <reason>`. Ids may be comma-separated. `promise list` shows everything open.",
				"These items stay open for reconciliation and will not prompt again unless explicitly snoozed or reopened. `promise list --review` shows the reconciliation queue. A reply or an active worker alone is not completion evidence.",
				...lines,
			].join("\n"),
		);
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

		// A snoozed or closed member of a pending batch is no longer part of it.
		const openIn = (members: { id: number; generation: number }[]) =>
			members.flatMap(({ id, generation }) =>
				this.items(
					"id = ? AND generation = ? AND state = 'open' AND attention = 'pending' AND due <= ?",
					id,
					generation,
					now,
				),
			);
		const send = (batch: number, items: Item[]) => {
			const result = this.attempt(batch, this.promptFor(items));

			// The hub's answer, the items' reminder counts and the prompt spacing are stored together. A run that dies
			// before this leaves the batch pending, and the retry goes out under the same key.
			this.atomic(() => {
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

				if (result.ok) {
					this.afterSent(items);

					if (items[0]?.kind === "promise") {
						this.setMeta("last_promise_prompt", String(now));
					}
				}
			});

			if (result.ok) {
				counts.sent += 1;

				counts.escalated += items.filter((i) => i.kind === "promise").length;
			} else {
				counts.failed += 1;
			}

			return result.ok;
		};

		// An inject that was recorded but not confirmed goes again under its own key before anything new.
		const attempted = new Set<number>();
		const retry = (kind: Item["kind"]) => {
			let retried = false;

			for (const row of this.db
				.prepare("SELECT id, items FROM batch WHERE state = 'pending' ORDER BY id")
				.all()) {
				const saved = JSON.parse(String(row["items"])) as (
					| number
					| { id: number; generation: number }
				)[];
				const items = openIn(
					saved.map((member) =>
						typeof member === "number" ? { id: member, generation: 0 } : member,
					),
				);

				if (items.length === 0) {
					this.db.prepare("UPDATE batch SET state = 'void' WHERE id = ?").run(Number(row["id"]));
				} else if (items[0]?.kind === kind) {
					for (const item of items) {
						attempted.add(item.id);
					}

					if (kind === "reminder" || !retried) {
						send(Number(row["id"]), items);
						retried = true;
					}
				}
			}

			return retried;
		};

		// The key is complete in the row from the start: the store's nonce and a random part, never an id that a
		// recreated store could hand out again.
		const create = (source: string, items: Item[]) =>
			Number(
				this.db
					.prepare("INSERT INTO batch (key, source, items, created) VALUES (?, ?, ?, ?)")
					.run(
						`promise-ledger:${this.meta("nonce") ?? ""}:${randomBytes(6).toString("hex")}`,
						source,
						JSON.stringify(items.map((i) => ({ id: i.id, generation: i.generation }))),
						now,
					).lastInsertRowid,
			);

		retry("reminder");

		for (const reminder of this.items("state = 'open' AND kind = 'reminder' AND due <= ?", now)) {
			if (!attempted.has(reminder.id)) {
				send(create(reminder.name ?? "reminder", [reminder]), [reminder]);
			}
		}

		const last = Number(this.meta("last_promise_prompt") ?? 0);

		if (now - last < config.promptEveryMs) {
			return counts;
		}

		if (retry("promise")) {
			return counts;
		}

		const overdue = this.items(
			"state = 'open' AND kind = 'promise' AND attention = 'pending' AND due <= ?",
			now,
		)
			.filter((item) => !attempted.has(item.id))
			.slice(0, config.promptCap);

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
				`${tag}: made ${day(item.created)}Z, due ${day(item.due)}Z, currently ${item.state}: ${clip(item.text, 200)}`,
			];
		}

		if (!item.claim) {
			return undefined;
		}

		const how =
			item.state === "open"
				? "reopened"
				: item.closed_by === "auto"
					? "closed automatically"
					: item.state === "dropped"
						? "dropped"
						: "closed as done";

		return [
			...base,
			"--replaces",
			item.claim,
			`${tag}: ${how} ${day(item.closed ?? item.changed)}Z (${clip(item.evidence ?? "", 200)}): ${clip(item.text, 200)}`,
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

	private locked<T>(body: () => T): T | { skipped: string } {
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
			return body();
		} finally {
			this.db.prepare("UPDATE meta SET v = '0' WHERE k = 'lock' AND v = ?").run(String(now));
		}
	}

	/** One run of everything, under a lock shared with explicit backfills. */
	sweep() {
		return this.locked(() => this.sweepStages());
	}

	private sweepStages() {
		const now = this.deps.now();

		// Each stage runs even if an earlier one failed: a history file that cannot be read must not stop reminders.
		const errors: string[] = [];
		const stage = <T>(name: string, body: () => T): T | undefined => {
			try {
				return body();
			} catch (error) {
				errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);

				return undefined;
			}
		};

		const result = {
			at: new Date(now).toISOString(),
			ingest: stage("ingest", () => this.ingest()),
			recorded: stage("record", () => this.recordOverdue()),
			remind: stage("remind", () => this.remind()),
			vault: stage("vault", () => this.drainOutbox()),
			errors,
		};

		this.setMeta("last_sweep", JSON.stringify(result));

		return result;
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
		const attention = db
			.prepare("PRAGMA table_info(item)")
			.all()
			.some((c) => c["name"] === "attention");
		const row = db
			.prepare(
				`SELECT
           COALESCE(SUM(state = 'open' AND kind = 'promise'), 0) AS open,
           COALESCE(SUM(state = 'open' AND kind = 'promise' AND due <= ?), 0) AS overdue,
           COALESCE(SUM(state = 'open' AND kind = 'promise' AND ${attention ? "attention = 'review'" : "escalated = 1"}), 0) AS review,
           COALESCE(SUM(state = 'open' AND kind = 'promise' AND ${attention ? "attention = 'quiet'" : "0"}), 0) AS quiet,
           COALESCE(SUM(state = 'open' AND kind = 'reminder'), 0) AS reminders,
           COALESCE(SUM(closed_by = 'auto' AND closed > ?), 0) AS auto
         FROM item`,
			)
			.get(now, now - 24 * HOUR);
		const n = (key: string) => String(row?.[key] ?? 0);
		// A wrong automatic close is a dropped promise, so automatic closes are never silent.
		const auto =
			Number(row?.["auto"] ?? 0) > 0
				? ` ${n("auto")} closed automatically in the last day (\`promise list --all\`; \`promise reopen <id>\` if wrong).`
				: "";

		return `Promise ledger: ${n("open")} open promise(s), ${n("overdue")} overdue, ${n("review")} awaiting reconciliation, ${n("quiet")} quiet progress item(s), ${n("reminders")} timed reminder(s) scheduled. List with \`promise list\` or \`promise list --review\`; reconcile with \`promise done|snooze|drop <id>\`.${auto}`;
	} finally {
		db.close();
	}
}
