import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { HistoryEntry, JobStatus } from "$lib/api";
import type { LabelDoc, Template, TemplateField, Vars } from "$lib/doc";

/**
 * Each step runs once, in order; `user_version` records how many have run, so opening an existing
 * database applies only the missing steps.
 */
const MIGRATIONS = [
	`CREATE TABLE templates (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		category TEXT NOT NULL,
		description TEXT NOT NULL,
		doc TEXT NOT NULL,
		fields TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE UNIQUE INDEX templates_name ON templates (name COLLATE NOCASE);
	CREATE TABLE history (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		title TEXT NOT NULL,
		template_id TEXT,
		doc TEXT NOT NULL,
		rows TEXT NOT NULL,
		options TEXT NOT NULL,
		tape_mm INTEGER NOT NULL,
		pages INTEGER NOT NULL,
		length_mm REAL NOT NULL,
		status TEXT NOT NULL,
		error TEXT
	);
	CREATE TABLE history_pages (
		history_id TEXT NOT NULL REFERENCES history (id) ON DELETE CASCADE,
		n INTEGER NOT NULL,
		png BLOB NOT NULL,
		PRIMARY KEY (history_id, n)
	);`,
];

interface TemplateRow {
	id: string;
	name: string;
	category: Template["category"];
	description: string;
	doc: string;
	fields: string;
	updated_at: string;
}

interface HistoryRow {
	id: string;
	created_at: string;
	title: string;
	template_id: string | null;
	doc: string;
	rows: string;
	options: string;
	tape_mm: number;
	pages: number;
	length_mm: number;
	status: JobStatus;
	error: string | null;
}

type HistoryOptions = Pick<HistoryEntry, "copies" | "cut" | "chain" | "dryRun">;

export class Store {
	readonly #db: DatabaseSync;

	/** `dataDir` is a data directory, or ":memory:" for a throwaway database. */
	constructor(dataDir: string) {
		if (dataDir !== ":memory:") {
			mkdirSync(dataDir, { recursive: true });
		}

		this.#db = new DatabaseSync(
			dataDir === ":memory:" ? dataDir : path.join(dataDir, "label-studio.db"),
		);

		this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		this.#migrate();
	}

	#migrate(): void {
		const { user_version: done } = this.#db.prepare("PRAGMA user_version").get() as {
			user_version: number;
		};

		for (const [index, step] of MIGRATIONS.entries()) {
			if (index < done) {
				continue;
			}

			this.#db.exec("BEGIN");
			this.#db.exec(step);
			this.#db.exec(`PRAGMA user_version = ${String(index + 1)}`);
			this.#db.exec("COMMIT");
		}
	}

	close(): void {
		this.#db.close();
	}

	listTemplates(): Template[] {
		return (
			this.#db
				.prepare("SELECT * FROM templates ORDER BY name COLLATE NOCASE")
				.all() as unknown as TemplateRow[]
		).map(toTemplate);
	}

	findTemplate(idOrName: string): Template | null {
		const row = this.#db
			.prepare(
				"SELECT * FROM templates WHERE id = ? OR name = ? COLLATE NOCASE ORDER BY id = ? DESC LIMIT 1",
			)
			.get(idOrName, idOrName, idOrName) as TemplateRow | undefined;

		return row ? toTemplate(row) : null;
	}

	/** False when another template already has this name (case-insensitive). */
	saveTemplate(template: Template): boolean {
		const clash = this.#db
			.prepare("SELECT id FROM templates WHERE name = ? COLLATE NOCASE AND id != ?")
			.get(template.name, template.id);

		if (clash) {
			return false;
		}

		this.#db
			.prepare(
				`INSERT INTO templates (id, name, category, description, doc, fields, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET name = excluded.name, category = excluded.category,
					description = excluded.description, doc = excluded.doc, fields = excluded.fields,
					updated_at = excluded.updated_at`,
			)
			.run(
				template.id,
				template.name,
				template.category,
				template.description,
				JSON.stringify(template.doc),
				JSON.stringify(template.fields),
				template.updatedAt,
			);

		return true;
	}

	deleteTemplate(id: string): boolean {
		return this.#db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes > 0;
	}

	insertHistory(entry: HistoryEntry, pages: readonly Uint8Array[]): void {
		const options: HistoryOptions = {
			copies: entry.copies,
			cut: entry.cut,
			chain: entry.chain,
			dryRun: entry.dryRun,
		};

		this.#db.exec("BEGIN");

		try {
			this.#db
				.prepare(
					`INSERT INTO history (id, created_at, title, template_id, doc, rows, options, tape_mm,
						pages, length_mm, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					entry.id,
					entry.createdAt,
					entry.title,
					entry.templateId,
					JSON.stringify(entry.doc),
					JSON.stringify(entry.rows),
					JSON.stringify(options),
					entry.tapeMm,
					entry.pages,
					entry.lengthMm,
					entry.status,
					entry.error ?? null,
				);

			const insert = this.#db.prepare(
				"INSERT INTO history_pages (history_id, n, png) VALUES (?, ?, ?)",
			);

			for (const [n, png] of pages.entries()) {
				insert.run(entry.id, n, png);
			}

			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");

			throw error;
		}
	}

	setHistoryStatus(id: string, status: JobStatus, error?: string): void {
		this.#db
			.prepare("UPDATE history SET status = ?, error = ? WHERE id = ?")
			.run(status, error ?? null, id);
	}

	/** Jobs live in memory, so entries still queued or printing at startup lost their worker. */
	failInterrupted(message: string): number {
		return Number(
			this.#db
				.prepare(
					"UPDATE history SET status = 'failed', error = ? WHERE status IN ('queued', 'printing')",
				)
				.run(message).changes,
		);
	}

	/** Newest first; `before` is the id of the last entry of the previous page. */
	listHistory(limit: number, before?: string): HistoryEntry[] {
		const rows = (before === undefined
			? this.#db.prepare("SELECT * FROM history ORDER BY seq DESC LIMIT ?").all(limit)
			: this.#db
					.prepare(
						"SELECT * FROM history WHERE seq < (SELECT seq FROM history WHERE id = ?) ORDER BY seq DESC LIMIT ?",
					)
					.all(before, limit)) as unknown as HistoryRow[];

		return rows.map(toHistory);
	}

	getHistory(id: string): HistoryEntry | null {
		const row = this.#db.prepare("SELECT * FROM history WHERE id = ?").get(id) as
			| HistoryRow
			| undefined;

		return row ? toHistory(row) : null;
	}

	historyPages(id: string): Uint8Array[] {
		return (
			this.#db.prepare("SELECT png FROM history_pages WHERE history_id = ? ORDER BY n").all(id) as {
				png: Uint8Array;
			}[]
		).map((row) => row.png);
	}

	historyPage(id: string, n: number): Uint8Array | null {
		const row = this.#db
			.prepare("SELECT png FROM history_pages WHERE history_id = ? AND n = ?")
			.get(id, n) as { png: Uint8Array } | undefined;

		return row?.png ?? null;
	}
}

function toTemplate(row: TemplateRow): Template {
	return {
		id: row.id,
		name: row.name,
		category: row.category,
		description: row.description,
		doc: JSON.parse(row.doc) as LabelDoc,
		fields: JSON.parse(row.fields) as TemplateField[],
		builtin: false,
		updatedAt: row.updated_at,
	};
}

function toHistory(row: HistoryRow): HistoryEntry {
	const options = JSON.parse(row.options) as HistoryOptions;

	return {
		id: row.id,
		createdAt: row.created_at,
		title: row.title,
		templateId: row.template_id,
		doc: JSON.parse(row.doc) as LabelDoc,
		rows: JSON.parse(row.rows) as Vars[],
		tapeMm: row.tape_mm,
		pages: row.pages,
		copies: options.copies,
		lengthMm: row.length_mm,
		cut: options.cut,
		chain: options.chain,
		dryRun: options.dryRun,
		status: row.status,
		...(row.error === null ? {} : { error: row.error }),
	};
}
