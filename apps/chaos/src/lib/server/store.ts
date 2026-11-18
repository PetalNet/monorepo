import { DatabaseSync } from "node:sqlite";

import type { Alert } from "./alerts";
import type { Advisory } from "./ics";
import type { KevEntry } from "./kev";
import type { Headline, NewsDay } from "./news";
import type { Claim, ClaimLevel } from "./status/services";

export interface Store {
	/** Replaces the whole catalog with this pull, so an entry CISA removed is gone here too. */
	save: (entries: readonly KevEntry[], lastModified: string | null, now: Date) => void;
	markChecked: (now: Date) => void;
	/** The feed's Last-Modified from the last pull that carried a body. */
	lastModified: () => string | undefined;
	checkedAt: () => string | undefined;
	/** Entries CISA added on any day from `from` to `to`, both included. */
	addedBetween: (from: string, to: string) => KevEntry[];
	/** How many entries CISA added on each day from `from` to `to`. Days with none are absent. */
	countsByDay: (from: string, to: string) => Map<string, number>;
	size: () => number;
	/** The first day CISA added anything that is still on the list. */
	earliestDay: () => string | undefined;
	/** When a named source was last checked, with its ETag and the start of what our record covers. */
	source: (
		id: string,
	) => { etag: string | undefined; checkedAt: string; since: string | undefined } | undefined;
	markSource: (id: string, now: Date) => void;
	/** Replaces the advisory list with this pull. */
	saveAdvisories: (advisories: readonly Advisory[], etag: string | null, now: Date) => void;
	advisoryCounts: (from: string, to: string) => Map<string, number>;
	earliestAdvisory: () => string | undefined;
	/**
	 * Adds alerts to the record. `since` is how far back this pull reached. The record's start is the
	 * first pull's reach, and moves to this pull's reach when `restart` says alerts were missed.
	 */
	saveAlerts: (alerts: readonly Alert[], since: Date, now: Date, restart: boolean) => void;
	/** Alerts sent at or after `from`, newest first. */
	alertsSince: (from: Date) => Alert[];
	saveNewsDay: (day: NewsDay) => void;
	/** Counted days from `from` on, oldest first. */
	newsDays: (from: string) => NewsDay[];
	/** Replaces the headlines on show and records a finished round of news counting. */
	saveHeadlines: (headlines: readonly Headline[], now: Date) => void;
	headlines: () => Headline[];
	saveClaim: (service: string, claim: Claim, now: Date) => void;
	claim: (service: string) => (Claim & { checkedAt: string }) | undefined;
	/** Records one probe and keeps the count of failures in a row, with no long gap between them. */
	saveProbe: (service: string, reachable: boolean, detail: string, now: Date) => void;
	probe: (
		service: string,
	) => { reachable: boolean; detail: string; fails: number; checkedAt: string } | undefined;
	/** The most recent day before `date` on which CISA added anything. */
	latestDayBefore: (date: string) => string | undefined;
}

/** A failed probe that follows a gap this long starts a new run of failures. */
const ROW_GAP = 25 * 60 * 1000;

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
		CREATE TABLE IF NOT EXISTS source (
			id TEXT PRIMARY KEY,
			etag TEXT,
			checked_at TEXT NOT NULL,
			since TEXT
		);
		CREATE TABLE IF NOT EXISTS ics_advisory (id TEXT PRIMARY KEY, published TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS ics_published ON ics_advisory (published);
		CREATE TABLE IF NOT EXISTS alert (
			id TEXT PRIMARY KEY,
			event TEXT NOT NULL,
			sent TEXT NOT NULL,
			area TEXT NOT NULL,
			headline TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS alert_sent ON alert (sent);
		CREATE TABLE IF NOT EXISTS news_day (
			day TEXT PRIMARY KEY,
			articles INTEGER NOT NULL,
			capped INTEGER NOT NULL,
			final INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS headline (
			url TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			outlet TEXT NOT NULL,
			published TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS service_claim (
			service TEXT PRIMARY KEY,
			level TEXT NOT NULL,
			text TEXT NOT NULL,
			checked_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS service_probe (
			service TEXT PRIMARY KEY,
			reachable INTEGER NOT NULL,
			detail TEXT NOT NULL,
			fails INTEGER NOT NULL,
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
	const between = db.prepare(`SELECT ${COLUMNS} FROM kev WHERE date_added BETWEEN ? AND ?`);
	const byDay = db.prepare(`
		SELECT date_added AS day, count(*) AS added FROM kev
		WHERE date_added BETWEEN ? AND ? GROUP BY date_added`);
	const earliest = db.prepare("SELECT min(date_added) AS day FROM kev");
	const total = db.prepare("SELECT count(*) AS entries FROM kev");
	const dayBefore = db.prepare("SELECT max(date_added) AS day FROM kev WHERE date_added < ?");

	const getSource = db.prepare(
		"SELECT etag, checked_at AS checkedAt, since FROM source WHERE id = ?",
	);
	// A 304 keeps the stored ETag, and the first `since` is never moved forward.
	const setSource = db.prepare(`
		INSERT INTO source (id, etag, checked_at, since) VALUES (?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			etag = coalesce(excluded.etag, source.etag), checked_at = excluded.checked_at,
			since = coalesce(source.since, excluded.since)`);
	const restartSource = db.prepare("UPDATE source SET since = ? WHERE id = ?");
	const addAdvisory = db.prepare("INSERT INTO ics_advisory (id, published) VALUES (?, ?)");
	const advisoriesByDay = db.prepare(`
		SELECT published AS day, count(*) AS added FROM ics_advisory
		WHERE published BETWEEN ? AND ? GROUP BY published`);
	const firstAdvisory = db.prepare("SELECT min(published) AS day FROM ics_advisory");
	const addAlert = db.prepare(`
		INSERT INTO alert (id, event, sent, area, headline) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (id) DO NOTHING`);
	const alertsFrom = db.prepare(
		"SELECT id, event, sent, area, headline FROM alert WHERE sent >= ? ORDER BY sent DESC",
	);
	const setNewsDay = db.prepare(`
		INSERT INTO news_day (day, articles, capped, final) VALUES (?, ?, ?, ?)
		ON CONFLICT (day) DO UPDATE SET
			articles = excluded.articles, capped = excluded.capped, final = excluded.final`);
	const getNewsDays = db.prepare(
		"SELECT day, articles, capped, final FROM news_day WHERE day >= ? ORDER BY day",
	);
	const addHeadline = db.prepare(
		"INSERT OR REPLACE INTO headline (url, title, outlet, published) VALUES (?, ?, ?, ?)",
	);
	const getHeadlines = db.prepare(
		"SELECT title, outlet, url, published FROM headline ORDER BY published DESC",
	);
	const setClaim = db.prepare(`
		INSERT INTO service_claim (service, level, text, checked_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (service) DO UPDATE SET
			level = excluded.level, text = excluded.text, checked_at = excluded.checked_at`);
	const getClaim = db.prepare(
		"SELECT level, text, checked_at AS checkedAt FROM service_claim WHERE service = ?",
	);
	const setProbe = db.prepare(`
		INSERT INTO service_probe (service, reachable, detail, fails, checked_at)
		VALUES (?1, ?2, ?3, 1 - ?2, ?4)
		ON CONFLICT (service) DO UPDATE SET
			reachable = excluded.reachable, detail = excluded.detail, checked_at = excluded.checked_at,
			fails = CASE
				WHEN excluded.reachable = 1 THEN 0
				WHEN service_probe.checked_at < ?5 THEN 1
				ELSE service_probe.fails + 1
			END`);
	const getProbe = db.prepare(
		"SELECT reachable, detail, fails, checked_at AS checkedAt FROM service_probe WHERE service = ?",
	);

	const atomically = (work: () => void): void => {
		db.exec("BEGIN");

		try {
			work();
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");

			throw error;
		}
	};

	return {
		source(id) {
			const row = getSource.get(id);

			return (
				row && {
					etag: (row.etag as string | null) ?? undefined,
					checkedAt: row.checkedAt as string,
					since: (row.since as string | null) ?? undefined,
				}
			);
		},
		markSource: (id, now) => void setSource.run(id, null, now.toISOString(), null),
		saveAdvisories(advisories, etag, now) {
			atomically(() => {
				db.exec("DELETE FROM ics_advisory");

				for (const advisory of advisories) {
					addAdvisory.run(advisory.id, advisory.published);
				}

				setSource.run("ics", etag, now.toISOString(), null);
			});
		},
		advisoryCounts: (from, to) =>
			new Map(advisoriesByDay.all(from, to).map((row) => [row.day as string, row.added as number])),
		earliestAdvisory: () => (firstAdvisory.get()?.day as string | null) ?? undefined,
		saveAlerts(alerts, since, now, restart) {
			atomically(() => {
				if (restart) {
					restartSource.run(since.toISOString(), "alerts");
				}

				for (const alert of alerts) {
					addAlert.run(alert.id, alert.event, alert.sent, alert.area, alert.headline);
				}

				setSource.run("alerts", null, now.toISOString(), since.toISOString());
			});
		},
		saveNewsDay: (day) =>
			void setNewsDay.run(day.day, day.articles, Number(day.capped), Number(day.final)),
		newsDays: (from) =>
			getNewsDays.all(from).map((row) => ({
				day: row.day as string,
				articles: row.articles as number,
				capped: row.capped === 1,
				final: row.final === 1,
			})),
		saveHeadlines(headlines, now) {
			atomically(() => {
				db.exec("DELETE FROM headline");

				for (const headline of headlines) {
					addHeadline.run(headline.url, headline.title, headline.outlet, headline.published);
				}

				setSource.run("news", null, now.toISOString(), null);
			});
		},
		headlines: () => getHeadlines.all() as unknown as Headline[],
		alertsSince: (from) => alertsFrom.all(from.toISOString()) as unknown as Alert[],
		saveClaim: (service, claim, now) =>
			void setClaim.run(service, claim.level, claim.text, now.toISOString()),
		claim(service) {
			const row = getClaim.get(service);

			return (
				row && {
					level: row.level as ClaimLevel,
					text: row.text as string,
					checkedAt: row.checkedAt as string,
				}
			);
		},
		saveProbe: (service, reachable, detail, now) =>
			void setProbe.run(
				service,
				Number(reachable),
				detail,
				now.toISOString(),
				new Date(now.getTime() - ROW_GAP).toISOString(),
			),
		probe(service) {
			const row = getProbe.get(service);

			return (
				row && {
					reachable: row.reachable === 1,
					detail: row.detail as string,
					fails: row.fails as number,
					checkedAt: row.checkedAt as string,
				}
			);
		},
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
		addedBetween: (from, to) =>
			between.all(from, to).map((row) => ({
				...(row as unknown as KevEntry),
				ransomware: row.ransomware === 1,
			})),
		countsByDay: (from, to) =>
			new Map(byDay.all(from, to).map((row) => [row.day as string, row.added as number])),
		size: () => total.get()?.entries as number,
		earliestDay: () => (earliest.get()?.day as string | null) ?? undefined,
		latestDayBefore: (date) => (dayBefore.get(date)?.day as string | null) ?? undefined,
	};
}
