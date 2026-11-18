import { DatabaseSync } from "node:sqlite";

import type { KevEntry } from "./kev";

export interface Store {
	/** Replaces the stored copy of each entry; `first_seen` keeps the time this store first saw it. */
	save: (entries: readonly KevEntry[], etag: string | null, now: Date) => void;
	markChecked: (now: Date) => void;
	etag: () => string | undefined;
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
			ransomware INTEGER NOT NULL,
			first_seen TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS kev_date_added ON kev (date_added);
		CREATE TABLE IF NOT EXISTS feed (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			etag TEXT,
			checked_at TEXT NOT NULL
		);
	`);

	const upsert = db.prepare(`
		INSERT INTO kev (cve_id, vendor, product, name, description, date_added, due_date, ransomware, first_seen)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (cve_id) DO UPDATE SET
			vendor = excluded.vendor, product = excluded.product, name = excluded.name,
			description = excluded.description, date_added = excluded.date_added,
			due_date = excluded.due_date, ransomware = excluded.ransomware`);
	const setFeed = db.prepare(`
		INSERT INTO feed (id, etag, checked_at) VALUES (1, ?, ?)
		ON CONFLICT (id) DO UPDATE SET etag = coalesce(excluded.etag, etag), checked_at = excluded.checked_at`);
	const feed = db.prepare("SELECT etag, checked_at FROM feed WHERE id = 1");
	const onDay = db.prepare(`SELECT ${COLUMNS} FROM kev WHERE date_added = ?`);
	const dayBefore = db.prepare("SELECT max(date_added) AS day FROM kev WHERE date_added < ?");

	return {
		save(entries, etag, now) {
			const seen = now.toISOString();

			db.exec("BEGIN");

			try {
				for (const e of entries) {
					upsert.run(
						e.cveId,
						e.vendor,
						e.product,
						e.name,
						e.description,
						e.dateAdded,
						e.dueDate,
						Number(e.ransomware),
						seen,
					);
				}

				setFeed.run(etag, seen);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");

				throw error;
			}
		},
		markChecked: (now) => void setFeed.run(null, now.toISOString()),
		etag: () => (feed.get()?.etag as string | null | undefined) ?? undefined,
		checkedAt: () => feed.get()?.["checked_at"] as string | undefined,
		addedOn: (date) =>
			onDay
				.all(date)
				.map((row) => ({ ...(row as unknown as KevEntry), ransomware: row.ransomware === 1 })),
		latestDayBefore: (date) => (dayBefore.get(date)?.day as string | null) ?? undefined,
	};
}
