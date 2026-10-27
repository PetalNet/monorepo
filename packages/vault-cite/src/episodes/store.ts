import { createHash } from "node:crypto";

import { z } from "zod";

import type { Store } from "../store.ts";
import { episodeMetadataSchema } from "./model.ts";
import type { EpisodeMetadata } from "./model.ts";

/**
 * Episodes share the same SQLite database and disk-guarded root as the rest of the vault-cite store
 * (same shape as sources/evidence: a metadata-row table plus a parallel FTS5 text table), so claims
 * can cite an episode exactly like they cite a source and nothing duplicates the disk guard or WAL
 * setup `Store` already does.
 */
export class EpisodeStore {
	readonly base: Store;
	constructor(base: Store) {
		this.base = base;

		this.base.db.exec(`
			CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
			CREATE VIRTUAL TABLE IF NOT EXISTS episode_text USING fts5(id UNINDEXED, text, agent UNINDEXED, room UNINDEXED, ts UNINDEXED);
			CREATE TABLE IF NOT EXISTS episode_cursors(source_path TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS known_secret_hashes(hash TEXT PRIMARY KEY, rule TEXT NOT NULL, first_seen_at TEXT NOT NULL);
		`);
	}

	static episodeId(originFile: string, originUuid: string | null, rowid: number): string {
		const key = originUuid
			? `${originFile}\u0000${originUuid}`
			: `${originFile}\u0000rowid:${String(rowid)}`;

		return `ep-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
	}

	/**
	 * Wraps a batch's writes in one transaction instead of one implicit transaction per statement --
	 * at recall.db's real scale (hundreds of thousands of messages) a commit-per-row insert loop is
	 * the dominant cost, not the redaction scan.
	 */
	withTransaction<T>(fn: () => T): T {
		this.base.db.exec("BEGIN IMMEDIATE");

		try {
			const result = fn();

			this.base.db.exec("COMMIT");

			return result;
		} catch (error) {
			this.base.db.exec("ROLLBACK");

			throw error;
		}
	}

	cursor(sourcePath: string): number {
		const row = this.base.db
			.prepare("SELECT last_rowid FROM episode_cursors WHERE source_path=?")
			.get(sourcePath);

		return row ? z.object({ last_rowid: z.number() }).parse(row).last_rowid : 0;
	}

	setCursor(sourcePath: string, lastRowid: number): void {
		this.base.db
			.prepare(
				"INSERT INTO episode_cursors(source_path,last_rowid) VALUES(?,?) ON CONFLICT(source_path) DO UPDATE SET last_rowid=excluded.last_rowid",
			)
			.run(sourcePath, lastRowid);
	}

	knownHashes(): Set<string> {
		const rows = this.base.db.prepare("SELECT hash FROM known_secret_hashes").all();

		return new Set(
			z
				.array(z.object({ hash: z.string() }))
				.parse(rows)
				.map((row) => row.hash),
		);
	}

	addKnownHashes(hashes: { hash: string; rule: string }[]): void {
		if (hashes.length === 0) {
			return;
		}

		const now = new Date().toISOString();
		const insert = this.base.db.prepare(
			"INSERT OR IGNORE INTO known_secret_hashes(hash,rule,first_seen_at) VALUES(?,?,?)",
		);

		for (const { hash, rule } of hashes) {
			insert.run(hash, rule, now);
		}
	}

	/** Idempotent: inserting an id that already exists is a no-op (episodes are immutable). */
	insert(id: string, metadata: EpisodeMetadata, text: string): boolean {
		episodeMetadataSchema.parse(metadata);

		const result = this.base.db
			.prepare("INSERT OR IGNORE INTO episodes(id,metadata) VALUES(?,?)")
			.run(id, JSON.stringify(metadata));

		if (result.changes) {
			this.base.db
				.prepare("INSERT INTO episode_text(id,text,agent,room,ts) VALUES(?,?,?,?,?)")
				.run(id, text, metadata.agent_id, metadata.session_id, metadata.ts);
		}

		return result.changes > 0;
	}

	getMetadata(id: string): EpisodeMetadata | undefined {
		const row = this.base.db.prepare("SELECT metadata FROM episodes WHERE id=?").get(id);

		return row
			? episodeMetadataSchema.parse(
					JSON.parse(z.object({ metadata: z.string() }).parse(row).metadata),
				)
			: undefined;
	}

	/**
	 * The one controlled exception to "episodes are immutable": masking a secret value that a later
	 * batch proved was secret, but that this episode's own batch could not have known about yet (the
	 * known-value hash set only grows forward). This never rewrites content for any other reason, and
	 * it only ever narrows text (masks), never changes an episode's id, provenance or any other
	 * field.
	 */
	updateText(id: string, text: string, metadata: EpisodeMetadata): void {
		episodeMetadataSchema.parse(metadata);
		this.base.db.prepare("UPDATE episode_text SET text=? WHERE id=?").run(text, id);

		this.base.db
			.prepare("UPDATE episodes SET metadata=? WHERE id=?")
			.run(JSON.stringify(metadata), id);
	}

	search(query: string) {
		return this.base.db
			.prepare(
				"SELECT id,snippet(episode_text,1,'[',']',' … ',24) AS snippet FROM episode_text WHERE episode_text MATCH ? ORDER BY rank LIMIT 30",
			)
			.all(query);
	}

	count(): number {
		return z
			.object({ n: z.number() })
			.parse(this.base.db.prepare("SELECT count(*) AS n FROM episodes").get()).n;
	}

	/**
	 * All indexed episode text, for post-ingest verification. Streams via the FTS5 table's own rowid,
	 * never collects everything into an array.
	 */
	*allText(): Generator<{ id: string; text: string }> {
		const batchSize = 500;
		let lastRowid = 0;

		for (;;) {
			const rows = z
				.array(z.object({ rowid: z.number(), id: z.string(), text: z.string() }))
				.parse(
					this.base.db
						.prepare("SELECT rowid,id,text FROM episode_text WHERE rowid>? ORDER BY rowid LIMIT ?")
						.all(lastRowid, batchSize),
				);

			if (rows.length === 0) {
				return;
			}

			for (const row of rows) {
				yield { id: row.id, text: row.text };
			}

			lastRowid = rows.at(-1)?.rowid ?? lastRowid;
		}
	}
}
