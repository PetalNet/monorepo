import { DatabaseSync } from "node:sqlite";

import type { KevEntry } from "./kev";

export interface Store {
	/** Replaces the whole catalog with this pull, so an entry CISA removed is gone here too. */
	save: (entries: readonly KevEntry[], lastModified: string | null, now: Date) => void;
	markChecked: (now: Date) => void;
	/** The feed's Last-Modified from the last pull that carried a body. */
	lastModified: () => string | undefined;
	checkedAt: () => string | undefined;
	addedOn: (date: string) => KevEntry[];
	/** The most recent day before `date` on which CISA added anything. */
	latestDayBefore: (date: string) => string | undefined;
}

const COLUMNS = `cve_id AS cveId, vendor, product, name, description,
	date_added AS dateAdded, due_date AS dueDate, ransomware`;

export function openStore(file: string): Store {
	const db = new DatabaseSync(file);

	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS kev (
			cve_id TEXT PRIMARY KEY,
			vendor TEXT NOT NULL,
			product TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			date_added TEXT NOT NULL,
			due_date TEXT NOT NULL,
			ransomware INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS kev_date_added ON kev (date_added);
		CREATE TABLE IF NOT EXISTS feed (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			last_modified TEXT,
			checked_at TEXT NOT NULL
		);
	`);

	const insert = db.prepare(`
		INSERT INTO kev (cve_id, vendor, product, name, description, date_added, due_date, ransomware)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
	const setFeed = db.prepare(`
		INSERT INTO feed (id, last_modified, checked_at) VALUES (1, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			last_modified = excluded.last_modified, checked_at = excluded.checked_at`);
	const touchFeed = db.prepare("UPDATE feed SET checked_at = ? WHERE id = 1");
	const feed = db.prepare("SELECT last_modified, checked_at FROM feed WHERE id = 1");
	const onDay = db.prepare(`SELECT ${COLUMNS} FROM kev WHERE date_added = ?`);
	const dayBefore = db.prepare("SELECT max(date_added) AS day FROM kev WHERE date_added < ?");

	return {
		save(entries, lastModified, now) {
			db.exec("BEGIN");

			try {
				db.exec("DELETE FROM kev");

				for (const e of entries) {
					insert.run(
						e.cveId,
						e.vendor,
						e.product,
						e.name,
						e.description,
						e.dateAdded,
						e.dueDate,
						Number(e.ransomware),
					);
				}

				setFeed.run(lastModified, now.toISOString());
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");

				throw error;
			}
		},
		markChecked: (now) => void touchFeed.run(now.toISOString()),
		lastModified: () => (feed.get()?.last_modified as string | null | undefined) ?? undefined,
		checkedAt: () => feed.get()?.checked_at as string | undefined,
		addedOn: (date) =>
			onDay.all(date).map((row) => ({
				...(row as unknown as KevEntry),
				ransomware: row.ransomware === 1,
			})),
		latestDayBefore: (date) => (dayBefore.get(date)?.day as string | null) ?? undefined,
	};
}
