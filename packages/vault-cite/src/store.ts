import { createHash } from "node:crypto";
import {
	chmodSync,
	openSync,
	closeSync,
	fsyncSync,
	unlinkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statfsSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { digest, DiskFull, jobSchema, sourceSchema } from "./model.ts";
import type { Artifact, Capture, Job, Source } from "./model.ts";

const reserve = 35 * 1024 ** 3;

export function diskGuard(root: string, incoming = 0): void {
	for (const diskPath of new Set([root, process.cwd()])) {
		const stat = statfsSync(diskPath);

		if (stat.bavail * stat.bsize - incoming < reserve) {
			throw new DiskFull("Disk guard: fewer than 35 GiB available after capture");
		}
	}
}

function hash(data: Buffer | string) {
	return digest.parse(createHash("sha256").update(data).digest("hex"));
}

export class Store {
	readonly root: string;
	readonly db: DatabaseSync;
	constructor(root: string) {
		this.root = path.resolve(root);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		chmodSync(this.root, 0o700);
		diskGuard(this.root);
		this.db = new DatabaseSync(path.join(this.root, "index.sqlite"));
		chmodSync(path.join(this.root, "index.sqlite"), 0o600);

		this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS jobs(ref TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0, source_id TEXT, reason TEXT);
   CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS evidence USING fts5(id UNINDEXED, title, authors, canonical_id, url, text);
   CREATE TABLE IF NOT EXISTS domains(host TEXT PRIMARY KEY, next_at REAL NOT NULL);
   CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id));`);
	}
	close() {
		this.db.close();
	}
	enqueue(ref: string) {
		return Number(
			this.db.prepare("INSERT OR IGNORE INTO jobs(ref,state) VALUES(?,'QUEUED')").run(ref).changes,
		);
	}
	job(ref: string): Job | undefined {
		const row = this.db.prepare("SELECT * FROM jobs WHERE ref=?").get(ref);

		return row ? jobSchema.parse(row) : undefined;
	}
	claim(ref?: string): Job | undefined {
		const now = Date.now();
		const row = this.db
			.prepare(`UPDATE jobs SET state='RUNNING', attempts=attempts+1, lease_until=? WHERE ref=(
   SELECT ref FROM jobs WHERE ((state='QUEUED' AND next_at<=?) OR (state='RUNNING' AND lease_until<?))
   AND (? IS NULL OR ref=?) ORDER BY next_at, ref LIMIT 1) RETURNING *`)
			.get(now + 15 * 60_000, now, now, ref ?? null, ref ?? null);

		return row ? jobSchema.parse(row) : undefined;
	}
	finish(
		job: Job,
		state: Job["state"],
		reason: string | null,
		sourceId: string | null = null,
		delay = 0,
	) {
		this.db
			.prepare(
				"UPDATE jobs SET state=?,reason=?,source_id=?,next_at=?,lease_until=0 WHERE ref=? AND lease_until=?",
			)
			.run(state, reason, sourceId, Date.now() + delay, job.ref, job.lease_until);
	}
	slot(host: string, interval: number): number {
		const row = this.db
			.prepare(
				`INSERT INTO domains(host,next_at) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET next_at=max(domains.next_at,?)+? RETURNING next_at`,
			)
			.get(host, Date.now() + interval, Date.now(), interval);

		return z.object({ next_at: z.number() }).parse(row).next_at - interval;
	}
	write(relative: string, data: Buffer | string) {
		const target = path.join(this.root, relative);

		mkdirSync(path.resolve(target, ".."), { recursive: true, mode: 0o700 });
		diskGuard(this.root, Buffer.byteLength(data));
		const temp = `${target}.${crypto.randomUUID()}.tmp`;

		const fd = openSync(temp, "wx", 0o600);

		try {
			writeFileSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}

		try {
			renameSync(temp, target);
		} finally {
			if (existsSync(temp)) {
				unlinkSync(temp);
			}
		}

		const directory = openSync(path.dirname(target), "r");

		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	}
	save(capture: Capture): Source {
		this.db.exec("BEGIN IMMEDIATE");

		try {
			const source = this.saveCapture(capture);

			this.db.exec("COMMIT");

			return source;
		} catch (error) {
			this.db.exec("ROLLBACK");

			throw error;
		}
	}
	private saveCapture(capture: Capture): Source {
		const artifacts: Artifact[] = capture.artifacts.map(({ data, mime }) => {
			const sha256 = hash(data);
			const filePath = `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/artifact`;

			if (existsSync(path.join(this.root, filePath))) {
				if (hash(readFileSync(path.join(this.root, filePath))) !== sha256) {
					throw new Error("Stored artifact checksum mismatch");
				}
			} else {
				this.write(filePath, data);
			}

			return { sha256, mime, path: filePath, bytes: data.length };
		});
		const first = artifacts[0];

		if (!first) {
			throw new Error("Capture has no artifact");
		}

		// A source identifies bytes. Acquisition provenance is retained per canonical reference.
		const id = `src-${first.sha256.slice(0, 20)}`;
		const textPath = `${first.path}.txt`;

		const metadata = sourceSchema.parse({
			schema_version: 1,
			layer: "EVIDENCE",
			source_type: "PRIMARY",
			id,
			url: capture.url,
			canonical_id: capture.canonicalId,
			title: capture.title,
			authors: capture.authors,
			fetched_at: new Date().toISOString(),
			sha256: first.sha256,
			mime: first.mime,
			access_status: "SAVED",
			extractor: capture.extractor,
			artifacts,
			text_path: textPath,
		});
		const existing = this.get(id);

		if (existing && existing.sha256 !== metadata.sha256) {
			throw new Error("Source ID collision");
		}

		this.write(
			`${first.path}.${hash(capture.canonicalId).slice(0, 16)}.json`,
			JSON.stringify(metadata, null, 2),
		);

		if (existing) {
			return existing;
		}

		this.write(textPath, capture.text);
		this.write(`${first.path}.json`, JSON.stringify(metadata, null, 2));

		this.write(
			`notes/${id}.md`,
			`---\n${JSON.stringify(metadata, null, 2)}\n---\n\n# ${capture.title.replace(/[\r\n]/g, " ")}\n\nSaved primary artifact. Retrieved ${metadata.fetched_at}.\n\nArtifact: [${first.sha256}](../${first.path})\n\nUse in a claim: \`source:: [[${id}]]\`\n\nClaim relations: \`supports:: [[claim-id]]\`, \`contradicts:: [[claim-id]]\`, \`replaces:: [[claim-id]]\`.\n`,
		);

		this.db.prepare("INSERT INTO sources VALUES(?,?)").run(id, JSON.stringify(metadata));

		this.db
			.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?)")
			.run(
				id,
				capture.title,
				capture.authors.join("; "),
				capture.canonicalId,
				capture.url,
				capture.text,
			);

		return metadata;
	}
	get(ref: string): Source | undefined {
		const row = this.db
			.prepare(
				"SELECT metadata FROM sources WHERE id=? OR id=(SELECT source_id FROM jobs WHERE ref=?)",
			)
			.get(ref, ref);

		if (!row) {
			return undefined;
		}

		return sourceSchema.parse(JSON.parse(z.object({ metadata: z.string() }).parse(row).metadata));
	}
	search(query: string) {
		return this.db
			.prepare(
				"SELECT id,title,canonical_id,snippet(evidence,5,'[',']',' … ',24) AS snippet FROM evidence WHERE evidence MATCH ? ORDER BY rank LIMIT 30",
			)
			.all(query);
	}
	status() {
		return this.db
			.prepare("SELECT state,count(*) AS count FROM jobs GROUP BY state ORDER BY state")
			.all();
	}
}
