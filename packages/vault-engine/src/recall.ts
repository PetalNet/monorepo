import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Clock, Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { Vault } from "./engine.ts";
import { Claim, Relation, Source, Tier, freshness, tiers } from "./schema.ts";
import { secretRules } from "./secrets.ts";

/**
 * The claim index is a read replica: a SQLite file rebuilt from the Loro documents and swapped in
 * with one rename, so a reader (the per-prompt recall hook) never sees a half-built index and never
 * needs the documents or the NAS.
 */
const SCHEMA = `
CREATE TABLE claim(
	id TEXT PRIMARY KEY, tier TEXT NOT NULL, topic TEXT NOT NULL,
	title TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
	source_type TEXT NOT NULL, verdict TEXT, freshness TEXT NOT NULL, sources TEXT NOT NULL,
	created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE VIRTUAL TABLE claim_fts USING fts5(id UNINDEXED, text, context, tokenize='porter unicode61');
CREATE TABLE passage(
	source TEXT NOT NULL, passage TEXT NOT NULL, tier TEXT NOT NULL, kind TEXT NOT NULL,
	title TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, freshness TEXT NOT NULL,
	PRIMARY KEY(source, passage));
CREATE VIRTUAL TABLE passage_fts USING fts5(source UNINDEXED, passage UNINDEXED, text, context, tokenize='porter unicode61');
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const SourceFreshness = Schema.Literals(["fresh", "stale", "replaced", "retracted"]);

const SourceRef = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	rel: Relation,
	passage: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	captured: Schema.String,
	freshness: SourceFreshness,
});

export type SourceRef = typeof SourceRef.Type;

export const ClaimCard = Schema.Struct({
	id: Schema.String,
	tier: Tier,
	title: Schema.String,
	heading: Schema.String,
	text: Schema.String,
	status: Claim.fields.status,
	sourceType: Claim.fields.sourceType,
	verdict: Schema.NullOr(Schema.String),
	/** What the claim's evidence looks like today: `flagged` means a cited source was retired. */
	freshness: Schema.Literals(["fresh", "stale", "flagged", "unsourced"]),
	sources: Schema.Array(SourceRef),
	score: Schema.Finite,
});
export type ClaimCard = typeof ClaimCard.Type;

export const PassageHit = Schema.Struct({
	source: Schema.String,
	passage: Schema.String,
	tier: Tier,
	kind: Source.fields.kind,
	title: Schema.String,
	heading: Schema.String,
	text: Schema.String,
	freshness: SourceFreshness,
	score: Schema.Finite,
});
export type PassageHit = typeof PassageHit.Type;

const { sourceType, score: _claimScore, ...claimFields } = ClaimCard.fields;
const ClaimRow = Schema.Struct({
	...claimFields,
	source_type: sourceType,
	sources: Schema.fromJsonString(Schema.Array(SourceRef)),
	rank: Schema.Finite,
});
const { score: _passageScore, ...passageFields } = PassageHit.fields;
const PassageRow = Schema.Struct({ ...passageFields, rank: Schema.Finite });

export const indexPath = (root: string) => path.join(root, "index.sqlite");

/** Rebuilds the claim index from the documents and swaps it in with one rename. */
export const reindex = Effect.gen(function* () {
	const vault = yield* Vault;
	const fs = yield* FileSystem.FileSystem;
	const view = yield* vault.view;
	const now = new Date(yield* Clock.currentTimeMillis);
	const target = indexPath(vault.root);
	const temporary = `${target}.${String(process.pid)}.tmp`;

	yield* fs.remove(temporary, { force: true });

	const counts = yield* Effect.acquireUseRelease(
		Effect.sync(() => new DatabaseSync(temporary)),
		(db) =>
			Effect.sync(() => {
				const counted = { claims: 0, passages: 0 };

				db.exec(SCHEMA);
				db.exec("BEGIN");

				const claim = db.prepare("INSERT INTO claim VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
				const claimFts = db.prepare("INSERT INTO claim_fts VALUES(?,?,?)");
				const passage = db.prepare("INSERT INTO passage VALUES(?,?,?,?,?,?,?,?)");
				const passageFts = db.prepare("INSERT INTO passage_fts VALUES(?,?,?,?)");

				for (const tier of tiers) {
					const state = view.tiers[tier];

					for (const record of Object.values(state.claims)) {
						const topic = state.topics[record.topic];
						const title = topic?.title ?? record.topic;
						const sources: SourceRef[] = record.links.flatMap((link) => {
							const source = view.source(link.target);

							return source
								? [
										{
											id: source.id,
											title: source.title,
											rel: link.rel,
											...(link.passage === undefined ? {} : { passage: link.passage }),
											...(source.url === undefined ? {} : { url: source.url }),
											captured: source.captured,
											freshness: freshness(source, topic?.shelfLifeDays, now),
										},
									]
								: [];
						});
						const backing = sources.filter(
							(source) => source.rel === "source" || source.rel === "supports",
						);
						const evidence: ClaimCard["freshness"] = record.stale
							? "flagged"
							: backing.length === 0
								? "unsourced"
								: backing.every((source) => source.freshness !== "fresh")
									? "stale"
									: "fresh";

						claim.run(
							record.id,
							tier,
							record.topic,
							title,
							record.heading,
							record.text,
							record.status,
							record.sourceType,
							record.verdict ?? null,
							evidence,
							JSON.stringify(sources),
							record.created,
							record.updated,
						);

						// The note title and heading are the claim's retrieval context, at no inference cost.
						claimFts.run(record.id, record.text, `${title} ${record.heading}`);
						counted.claims++;
					}

					for (const source of Object.values(state.sources)) {
						const fresh = freshness(source, undefined, now);

						for (const [id, text] of Object.entries(source.passages)) {
							const heading = source.headings?.[id] ?? "";

							passage.run(source.id, id, tier, source.kind, source.title, heading, text, fresh);
							passageFts.run(source.id, id, text, `${source.title} ${heading}`);
							counted.passages++;
						}
					}
				}

				db.prepare("INSERT INTO meta VALUES('built', ?)").run(now.toISOString());
				db.exec("COMMIT");

				return counted;
			}),
		(db) =>
			Effect.sync(() => {
				db.close();
			}),
	);

	yield* fs.rename(temporary, target);

	return counts;
});

/** Turns free text into an FTS5 query: each word quoted, any may match, ranking sorts it out. */
function ftsQuery(text: string): string {
	const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu))];

	return words.map((word) => `"${word}"`).join(" OR ");
}

export interface RecallOptions {
	readonly k?: number;
	readonly tiers?: readonly Tier[];
	/** Superseded and retracted claims are left out unless asked for. */
	readonly includeInactive?: boolean;
}

/** Runs one query against the index; no index yet, or a query with no words, finds nothing. */
const search = <A>(
	query: string,
	sql: string,
	row: Schema.Decoder<A>,
	options: RecallOptions,
): Recall<A> =>
	Effect.gen(function* () {
		const vault = yield* Vault;
		const fs = yield* FileSystem.FileSystem;
		const match = ftsQuery(query);

		if (match === "" || !(yield* fs.exists(indexPath(vault.root)))) {
			return [];
		}

		const rows = yield* Effect.acquireUseRelease(
			Effect.sync(() => new DatabaseSync(indexPath(vault.root), { readOnly: true })),
			(db) =>
				Effect.sync(() =>
					db.prepare(sql).all(match, JSON.stringify(options.tiers ?? tiers), options.k ?? 8),
				),
			(db) =>
				Effect.sync(() => {
					db.close();
				}),
		);

		return yield* Schema.decodeEffect(Schema.Array(row))(rows).pipe(Effect.orDie);
	});

type Recall<A> = Effect.Effect<readonly A[], PlatformError, Vault | FileSystem.FileSystem>;

export const recallClaims = (query: string, options: RecallOptions = {}): Recall<ClaimCard> =>
	search(
		query,
		`SELECT claim.*, bm25(claim_fts, 0.0, 1.0, 0.5) AS rank FROM claim_fts
			 JOIN claim ON claim.id = claim_fts.id
			 WHERE claim_fts MATCH ? ${options.includeInactive === true ? "" : "AND claim.status = 'active'"}
			 AND claim.tier IN (SELECT value FROM json_each(?))
			 ORDER BY rank LIMIT ?`,
		ClaimRow,
		options,
	).pipe(
		Effect.map((rows) =>
			rows.map(({ source_type, rank, ...card }): ClaimCard => ({
				...card,
				sourceType: source_type,
				score: -rank,
			})),
		),
	);

export const recallPassages = (query: string, options: RecallOptions = {}): Recall<PassageHit> =>
	search(
		query,
		`SELECT passage.*, bm25(passage_fts, 0.0, 0.0, 1.0, 0.5) AS rank FROM passage_fts
			 JOIN passage ON passage.source = passage_fts.source AND passage.passage = passage_fts.passage
			 WHERE passage_fts MATCH ? AND passage.tier IN (SELECT value FROM json_each(?))
			 ORDER BY rank LIMIT ?`,
		PassageRow,
		options,
	).pipe(
		Effect.map((rows) => rows.map(({ rank, ...hit }): PassageHit => ({ ...hit, score: -rank }))),
	);

/**
 * One line an agent can read and cite: the claim, where it lives, its evidence and how fresh that
 * is.
 */
export function renderCard(card: ClaimCard): string {
	const sources = card.sources
		.map(
			(source) =>
				`${source.rel} ${source.title} (${source.id}, ${source.captured.slice(0, 10)}, ${source.freshness})`,
		)
		.join("; ");

	return `[${card.id}] ${card.title} > ${card.heading}: ${card.text} | ${card.sourceType}, ${card.freshness}${sources === "" ? "" : ` | ${sources}`}`;
}

export const renderPassage = (hit: PassageHit) =>
	`[${hit.source}#^${hit.passage}] ${hit.title}${hit.heading === "" ? "" : ` > ${hit.heading}`} (${hit.kind}, ${hit.freshness}): ${hit.text.slice(0, 400)}`;

/**
 * Records what a recall returned. Paired with the op log (which claims an agent then cited), this
 * is the training signal for a later reranker; nothing reads it yet.
 */
export const logRecall = Effect.fnUntraced(function* (query: string, ids: readonly string[]) {
	const vault = yield* Vault;
	const fs = yield* FileSystem.FileSystem;
	const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
	// A query is whatever an agent was asked; one that carries a credential is logged without its text.
	const logged = secretRules([query]).length > 0 ? null : query;
	const dir = path.join(vault.root, "log");

	yield* fs.makeDirectory(dir, { recursive: true });

	yield* fs.writeFileString(
		path.join(dir, "recall.jsonl"),
		`${JSON.stringify({ ts, agent: vault.agent, query: logged, ids })}\n`,
		{ flag: "a" },
	);
});
