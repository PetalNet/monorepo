import { createHash } from "node:crypto";
import {
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

import {
	artifactSchema,
	digest,
	DiskFull,
	PacingDeferred,
	jobSchema,
	sourceSchema,
} from "./model.ts";
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
		// Modes apply only at creation; an existing root keeps its permissions, such as NFS ACLs that refuse chmod.
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		diskGuard(this.root);
		this.db = new DatabaseSync(path.join(this.root, "index-v2.sqlite"));

		this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS jobs(ref TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0, source_id TEXT, reason TEXT);
   CREATE TABLE IF NOT EXISTS retrievals(id TEXT PRIMARY KEY, ref TEXT NOT NULL, metadata TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS derivations(source_id TEXT PRIMARY KEY REFERENCES sources(id), state TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0, reason TEXT, manifest TEXT);
   CREATE TABLE IF NOT EXISTS source_projections(source_id TEXT PRIMARY KEY REFERENCES sources(id), metadata TEXT NOT NULL, artifact TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS evidence USING fts5(id UNINDEXED, title, authors, canonical_id, url, text);
   CREATE TABLE IF NOT EXISTS request_cache(ref TEXT NOT NULL REFERENCES jobs(ref), url TEXT NOT NULL, metadata TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY(ref,url));
   CREATE TABLE IF NOT EXISTS robots(origin TEXT PRIMARY KEY, content TEXT NOT NULL, expires_at REAL NOT NULL);
   CREATE TABLE IF NOT EXISTS domains(host TEXT PRIMARY KEY, next_at REAL NOT NULL);
   CREATE VIEW IF NOT EXISTS citations AS SELECT ref, CASE WHEN state='SAVED' AND source_id IN (SELECT id FROM sources) THEN 'SAVED' WHEN state IN ('QUEUED','RUNNING') THEN 'PENDING' WHEN state='INACCESSIBLE' THEN 'INACCESSIBLE' ELSE 'BLOCKED' END AS status,reason,source_id FROM jobs;
   CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id));`);
	}
	close() {
		this.db.close();
	}
	enqueue(ref: string, refresh = false) {
		if (refresh) {
			this.db.exec("BEGIN IMMEDIATE");

			try {
				const result = this.db
					.prepare(
						"UPDATE jobs SET state='QUEUED', attempts=0, next_at=0, lease_until=0, source_id=NULL, reason=NULL WHERE ref=? AND state != 'RUNNING'",
					)
					.run(ref);

				if (result.changes) {
					this.db.prepare("DELETE FROM request_cache WHERE ref=?").run(ref);
				}

				this.db.exec("COMMIT");
			} catch (error) {
				this.db.exec("ROLLBACK");

				throw error;
			}
		}

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
		const result = this.db
			.prepare(
				"UPDATE jobs SET state=?,reason=?,source_id=?,next_at=?,lease_until=0 WHERE ref=? AND lease_until=?",
			)
			.run(state, reason, sourceId, Date.now() + delay, job.ref, job.lease_until);

		if (result.changes && state !== "QUEUED") {
			this.db.prepare("DELETE FROM request_cache WHERE ref=?").run(job.ref);
		}
	}
	defer(job: Job, until: number) {
		this.db
			.prepare(
				"UPDATE jobs SET state='QUEUED',reason='Domain pacing deferred',attempts=max(0,attempts-1),next_at=?,lease_until=0 WHERE ref=? AND lease_until=?",
			)
			.run(until, job.ref, job.lease_until);
	}
	cooldown(host: string, delay: number) {
		this.db
			.prepare(
				"INSERT INTO domains VALUES(?,?) ON CONFLICT(host) DO UPDATE SET next_at=max(domains.next_at,excluded.next_at)",
			)
			.run(host, Date.now() + delay);
	}
	slot(host: string, interval: number): number {
		const now = Date.now();
		const row = this.db
			.prepare(
				`INSERT INTO domains(host,next_at) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET next_at=max(domains.next_at,?)+? WHERE domains.next_at<=? RETURNING next_at`,
			)
			.get(host, now + interval, now, interval, now + 30_000);

		if (row) {
			return z.object({ next_at: z.number() }).parse(row).next_at - interval;
		}

		const next = z
			.object({ next_at: z.number() })
			.parse(this.db.prepare("SELECT next_at FROM domains WHERE host=?").get(host)).next_at;

		throw new PacingDeferred(next);
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
	save(capture: Capture, job: Job): Source {
		this.db.exec("BEGIN IMMEDIATE");

		try {
			const current = this.job(job.ref);

			if (current?.state !== "RUNNING" || current.lease_until !== job.lease_until) {
				throw new Error("Capture lease no longer owned");
			}

			const source = this.saveCapture(capture, job.ref);

			this.finish(job, "SAVED", null, source.id);

			this.db.exec("COMMIT");

			return source;
		} catch (error) {
			this.db.exec("ROLLBACK");

			throw error;
		}
	}
	private blob(data: Buffer | string, role: "ORIGINAL" | "DERIVED") {
		const sha256 = hash(data);
		const filePath = `${role === "ORIGINAL" ? "originals" : "derived"}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/artifact`;

		if (existsSync(path.join(this.root, filePath))) {
			if (hash(readFileSync(path.join(this.root, filePath))) !== sha256) {
				throw new Error("Stored artifact checksum mismatch");
			}
		} else {
			this.write(filePath, data);
		}

		return { sha256, path: filePath, bytes: Buffer.byteLength(data) };
	}
	private saveCapture(capture: Capture, ref: string): Source {
		const original = capture.artifacts[0];

		if (original?.role !== "ORIGINAL") {
			throw new Error("Capture requires an original with HTTP provenance");
		}

		const originalHash = hash(original.data);
		const artifacts: Artifact[] = capture.artifacts.map((artifact) =>
			artifactSchema.parse({
				...this.blob(artifact.data, artifact.role),
				mime: artifact.mime,
				role: artifact.role,
				...(artifact.role === "DERIVED"
					? { original_sha256: originalHash }
					: { retrieval: artifact.retrieval }),
			}),
		);
		const first = artifacts[0];

		if (!first) {
			throw new Error("Missing original");
		}

		const previousRow = this.db
			.prepare("SELECT metadata FROM retrievals WHERE ref=? ORDER BY rowid DESC LIMIT 1")
			.get(ref);
		const previous = previousRow
			? sourceSchema.parse(
					JSON.parse(z.object({ metadata: z.string() }).parse(previousRow).metadata),
				)
			: undefined;
		const id = `src-${first.sha256.slice(0, 20)}`;
		const metadata = sourceSchema.parse({
			schema_version: 2,
			layer: "EVIDENCE",
			source_type: "PRIMARY",
			id,
			citation_ref: ref,
			canonical_id: capture.canonicalId,
			title: capture.title,
			authors: capture.authors,
			...original.retrieval,
			sha256: first.sha256,
			mime: first.mime,
			access_status: "SAVED",
			extractor: capture.extractor,
			artifacts,
			retrieval_id: crypto.randomUUID(),
			previous_retrieval_id: previous?.retrieval_id ?? null,
			previous_sha256: previous?.sha256 ?? null,
		});

		this.write(`retrievals/${metadata.retrieval_id}.json`, JSON.stringify(metadata, null, 2));

		this.db
			.prepare("INSERT INTO retrievals VALUES(?,?,?)")
			.run(metadata.retrieval_id, ref, JSON.stringify(metadata));

		const existing = this.get(id);

		if (existing && existing.sha256 !== metadata.sha256) {
			throw new Error("Source ID collision");
		}

		// Blob metadata is immutable; every fetch has a separate, linked receipt.
		for (const artifact of artifacts) {
			const sidecar =
				artifact.role === "ORIGINAL"
					? `${artifact.path}.json`
					: `${artifact.path}.${originalHash}.json`;

			if (!existsSync(path.join(this.root, sidecar))) {
				this.write(
					sidecar,
					JSON.stringify(
						{
							schema_version: 2,
							layer: "EVIDENCE",
							source_id: id,
							canonical_id: metadata.canonical_id,
							citation_ref: ref,
							title: metadata.title,
							authors: metadata.authors,
							...artifact,
							...(artifact.role === "ORIGINAL" ? artifact.retrieval : original.retrieval),
							source_type: artifact.role === "ORIGINAL" ? "PRIMARY" : "DERIVED",
							access_status: "SAVED",
							extractor: capture.extractor,
						},
						null,
						2,
					),
				);
			}
		}

		if (!existing) {
			this.db.prepare("INSERT INTO sources VALUES(?,?)").run(id, JSON.stringify(metadata));

			this.db
				.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?)")
				.run(id, capture.title, capture.authors.join("; "), capture.canonicalId, ref, "");

			this.db.prepare("INSERT INTO derivations(source_id) VALUES(?)").run(id);

			this.writeNote(metadata);
		}

		return metadata;
	}
	private writeNote(source: Source) {
		const first = source.artifacts[0];

		if (!first) {
			throw new Error("Missing source artifact");
		}

		this.write(
			`notes/${source.id}.md`,
			`---\n${JSON.stringify(source, null, 2)}\n---\n\n# ${source.title.replace(/[\r\n]/g, " ")}\n\nSaved original. Retrieved ${source.fetched_at}.\n\nArtifact: [${first.sha256}](../${first.path})\n\nUse in a claim: \`source:: [[${source.id}]]\`\n\nClaim relations: \`supports:: [[claim-id]]\`, \`contradicts:: [[claim-id]]\`, \`replaces:: [[claim-id]]\`.\n`,
		);
	}
	projectPdfMetadata(
		source: Source,
		fields: { title: string | null; author: string | null },
		lease: number,
	) {
		const data = JSON.stringify({
			role: "DERIVED",
			original_sha256: source.sha256,
			extractor: "pdfinfo",
			...fields,
		});
		const artifact = {
			...this.blob(data, "DERIVED"),
			role: "DERIVED",
			original_sha256: source.sha256,
			mime: "application/json",
			extractor: "pdfinfo",
		};

		this.write(`${artifact.path}.json`, JSON.stringify(artifact, null, 2));
		this.db.exec("BEGIN IMMEDIATE");

		try {
			if (
				this.db
					.prepare(
						"SELECT 1 FROM derivations WHERE source_id=? AND state='RUNNING' AND lease_until=?",
					)
					.get(source.id, lease)
			) {
				this.db
					.prepare(
						"INSERT INTO source_projections VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET metadata=excluded.metadata,artifact=excluded.artifact",
					)
					.run(source.id, JSON.stringify(fields), JSON.stringify(artifact));

				const projection = this.projected(source);

				this.db
					.prepare("UPDATE evidence SET title=?,authors=? WHERE id=?")
					.run(projection.title, projection.authors.join("; "), source.id);

				this.writeNote(projection);
			}

			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");

			throw error;
		}
	}
	private projected(source: Source): Source {
		const row = this.db
			.prepare("SELECT metadata,artifact FROM source_projections WHERE source_id=?")
			.get(source.id);

		if (!row) {
			return source;
		}

		const projection = z.object({ metadata: z.string(), artifact: z.string() }).parse(row);
		const schema = z.object({ title: z.string().nullable(), author: z.string().nullable() });
		const cached = schema.safeParse(JSON.parse(projection.metadata));
		let fields;

		if (cached.success) {
			fields = cached.data;
		} else {
			// Older projections merged the first receipt's metadata. Recover only pdfinfo's raw fields.
			const artifact = artifactSchema.parse(JSON.parse(projection.artifact));
			const bytes = readFileSync(path.join(this.root, artifact.path));

			if (hash(bytes) !== artifact.sha256) {
				throw new Error("PDF metadata artifact hash mismatch");
			}

			fields = schema.parse(JSON.parse(bytes.toString()));
		}

		return {
			...source,
			title:
				source.title && source.title !== source.canonical_id
					? source.title
					: (fields.title ?? source.title),
			authors: source.authors.length > 0 ? source.authors : fields.author ? [fields.author] : [],
		};
	}

	claimDerivation() {
		const now = Date.now();
		const row = this.db
			.prepare(
				`UPDATE derivations SET state='RUNNING',attempts=attempts+1,lease_until=? WHERE source_id=(SELECT source_id FROM derivations WHERE (state='PENDING' AND next_at<=?) OR (state='RUNNING' AND lease_until<?) ORDER BY rowid LIMIT 1) RETURNING source_id,attempts,lease_until`,
			)
			.get(now + 15 * 60_000, now, now);

		return row
			? z
					.object({ source_id: z.string(), attempts: z.number(), lease_until: z.number() })
					.parse(row)
			: undefined;
	}
	saveDerivation(
		source: Source,
		pages: { page: number; text: string; method: string }[],
		lease: number,
	) {
		const data = JSON.stringify(
			{
				schema_version: 1,
				role: "DERIVED",
				original_sha256: source.sha256,
				extractor: "cite-page-text-v1",
				pages,
			},
			null,
			2,
		);
		const artifact = {
			...this.blob(data, "DERIVED"),
			role: "DERIVED",
			original_sha256: source.sha256,
			mime: "application/json",
		};

		this.write(`${artifact.path}.json`, JSON.stringify(artifact, null, 2));
		this.db.exec("BEGIN IMMEDIATE");

		try {
			const result = this.db
				.prepare(
					"UPDATE derivations SET state='SAVED',reason=NULL,lease_until=0,manifest=? WHERE source_id=? AND lease_until=?",
				)
				.run(JSON.stringify(artifact), source.id, lease);

			if (result.changes) {
				this.db
					.prepare("UPDATE evidence SET text=? WHERE id=?")
					.run(pages.map((page) => page.text).join("\n"), source.id);
			}

			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");

			throw error;
		}
	}
	derivation(id: string) {
		return this.db.prepare("SELECT * FROM derivations WHERE source_id=?").get(id);
	}
	history(ref: string) {
		return this.db
			.prepare("SELECT metadata FROM retrievals WHERE ref=? ORDER BY rowid")
			.all(ref)
			.map((row) =>
				sourceSchema.parse(JSON.parse(z.object({ metadata: z.string() }).parse(row).metadata)),
			);
	}
	citation(ref: string) {
		return this.db.prepare("SELECT * FROM citations WHERE ref=?").get(ref);
	}

	get(ref: string): Source | undefined {
		if (!ref.startsWith("src-")) {
			if (this.job(ref)?.state !== "SAVED") {
				return undefined;
			}

			const source = this.history(ref).at(-1);

			return source ? this.projected(source) : undefined;
		}

		const row = this.db.prepare("SELECT metadata FROM sources WHERE id=?").get(ref);

		if (!row) {
			return undefined;
		}

		return this.projected(
			sourceSchema.parse(JSON.parse(z.object({ metadata: z.string() }).parse(row).metadata)),
		);
	}
	search(query: string) {
		return this.db
			.prepare(
				"SELECT id,title,canonical_id,snippet(evidence,5,'[',']',' … ',24) AS snippet FROM evidence WHERE evidence MATCH ? ORDER BY rank LIMIT 30",
			)
			.all(query);
	}
	status() {
		const citations = this.db.prepare("SELECT * FROM citations ORDER BY ref").all();

		return {
			counts: this.db
				.prepare("SELECT status,count(*) AS count FROM citations GROUP BY status ORDER BY status")
				.all(),
			citations,
			derivations: this.db
				.prepare("SELECT source_id,state,reason FROM derivations ORDER BY source_id")
				.all(),
		};
	}
}
