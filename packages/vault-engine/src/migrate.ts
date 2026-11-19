import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { Effect, FileSystem, Option, Schema } from "effect";

import { Vault } from "./engine.ts";
import type { NewSource, Tx, VaultView } from "./engine.ts";
import type { SecretFound, WriteRejected } from "./errors.ts";
import { Source, SourceType, Text, Tier, oneLine } from "./schema.ts";
import { secretRules } from "./secrets.ts";

const Timestamp = Text.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/));

/**
 * One line of a migration manifest. A `document` is a lab-written file copied in verbatim as a
 * source with one passage per heading section; a `capture` is a vault-cite source record. Originals
 * are only read.
 */
export const ManifestEntry = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("document"),
		kind: Schema.Literals(["research", "memory", "gallery", "context"]),
		tier: Tier,
		/** Where the original lives; recorded on the source and used as its stable identity. */
		origin: Text,
		/** The file to read. Differs from `origin` when the original was converted first. */
		file: Text,
		title: Text,
		captured: Timestamp,
		sourceType: SourceType,
	}),
	Schema.Struct({
		type: Schema.Literal("capture"),
		tier: Tier,
		id: Schema.String.check(Schema.isPattern(/^src-[a-f0-9]{20}$/)),
		title: Schema.String,
		url: Text,
		captured: Timestamp,
		/** Other names the same artifact is cited by: canonical ID, citation reference, final URL. */
		refs: Schema.optionalKey(Schema.Array(Schema.String)),
		/**
		 * Text quoted from the saved artifact, stored as a passage so recall finds a source no claim
		 * cites yet. The artifact itself stays in vault-cite.
		 */
		excerpt: Schema.optionalKey(Text),
	}),
]);
export type ManifestEntry = typeof ManifestEntry.Type;
type DocumentEntry = Extract<ManifestEntry, { type: "document" }>;
type CaptureEntry = Extract<ManifestEntry, { type: "capture" }>;

export interface MigrationReport {
	readonly migrated: { origin: string; id: string; passages: number }[];
	/** Left out on purpose. Paths and reasons only, never content. */
	readonly excluded: { origin: string; reason: string }[];
	/** Documents migrated without the few sections that matched the deny list. */
	readonly partial: { origin: string; sectionsExcluded: number }[];
	/** References a migrated document cites that the vault holds no saved source for. */
	readonly unsavedCitations: { ref: string; citedBy: string }[];
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const reportOrigin = (origin: string) =>
	secretRules([origin]).length === 0 ? origin : "(origin withheld by the secret scan)";
// Quoting a source adds `p-` passages; only the imported `sN` sections define its document version.
const documentSections = (passages: Readonly<Record<string, string>>) =>
	Object.fromEntries(Object.entries(passages).filter(([id]) => /^s[1-9]\d*$/.test(id)));
/** The ID `addPassage` gives the same text, so quoting an excerpt later reuses its passage. */
const passageId = (text: string) => `p-${sha256(text).slice(0, 10)}`;

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

/**
 * Splits a markdown document into heading sections. Text before the first heading is its own
 * section.
 */
function sections(body: string): { heading: string; text: string }[] {
	const result: { heading: string; text: string }[] = [];
	const trail: string[] = [];
	let lines: string[] = [];
	let heading = "";
	let fenced = false;

	const flush = () => {
		const text = lines.join("\n").trim();

		if (text !== "") {
			result.push({ heading, text });
		}

		lines = [];
	};

	for (const line of body.replace(FRONTMATTER, "").split("\n")) {
		if (/^\s*(?:```|~~~)/.test(line)) {
			fenced = !fenced;
		}

		const match = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);

		if (match) {
			flush();
			trail.length = (match[1]?.length ?? 1) - 1;
			trail.push(oneLine(match[2] ?? ""));
			heading = trail.filter(Boolean).join(" > ");
		}

		lines.push(line);
	}

	flush();

	return result;
}

/** Every form a citation of the same artifact may take, so a cited URL finds its saved source. */
function referenceKeys(ref: string): string[] {
	const trimmed = ref.trim().replace(/[).,;:'"\]>]+$/, "");
	const keys = new Set([trimmed, trimmed.replace(/\/$/, ""), trimmed.replace(/^http:/, "https:")]);
	const arxiv =
		/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/.exec(trimmed) ??
		/^arxiv:(\d{4}\.\d{4,5})/i.exec(trimmed);
	const doi = /(?:doi\.org\/|^doi:)(10\.\d{4,9}\/\S+)/i.exec(trimmed);

	if (arxiv?.[1] !== undefined) {
		keys.add(`arxiv:${arxiv[1]}`);
	}

	if (doi?.[1] !== undefined) {
		keys.add(`doi:${doi[1].toLowerCase()}`);
	}

	return [...keys];
}

const citedUrls = (body: string) => [
	...new Set(
		(body.match(/https?:\/\/[^\s<>"'`|\\^{}[\]]+/g) ?? []).map((url) =>
			url.replace(/[).,;:*_]+$/, ""),
		),
	),
];

/**
 * Only letters and digits count: case, spacing, punctuation, markup and look-alike characters hide
 * nothing.
 */
const fold = (text: string) =>
	text
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, "");

function documentHead(view: VaultView, entry: DocumentEntry) {
	const root = `doc-${sha256(`${entry.kind}\n${entry.origin}`).slice(0, 16)}`;
	const visited = new Set<string>();
	let current = view.source(root);

	while (current !== undefined) {
		if (
			visited.has(current.id) ||
			view.locate(current.id)?.tier !== entry.tier ||
			current.kind !== entry.kind ||
			current.origin !== entry.origin
		) {
			return { valid: false } as const;
		}

		visited.add(current.id);

		if (current.status === "active") {
			return { valid: true, root, head: current } as const;
		}

		if (current.status !== "replaced" || current.replacedBy === undefined) {
			return { valid: false } as const;
		}

		current = view.source(current.replacedBy);

		if (current === undefined) {
			return { valid: false } as const;
		}
	}

	return { valid: true, root, head: undefined } as const;
}

/**
 * Copies every manifest entry into the vault or names it in the report. `denyKeywords` is the
 * out-of-scope list: any entry whose path, title, frontmatter or text contains one is excluded
 * whole, as is any entry the secret scan rejects. `passingSections` relaxes that for documents that
 * only mention a denied subject: one with at most that many matching sections is migrated without
 * those sections. Rerunning the same manifest converges on the same vault.
 */
export const migrate = Effect.fnUntraced(function* (
	entries: readonly ManifestEntry[],
	denyKeywords: readonly string[],
	passingSections = 0,
) {
	const vault = yield* Vault;
	const fs = yield* FileSystem.FileSystem;
	const report: MigrationReport = { migrated: [], excluded: [], partial: [], unsavedCitations: [] };
	const denied = denyKeywords.map(fold).filter(Boolean);
	const outOfScope = (text: string) => denied.some((keyword) => fold(text).includes(keyword));
	/** Reference key to the ID of a capture that is now in the vault. */
	const saved = new Map<string, { id: string; tier: Tier }>();

	/** One transaction per tier; an entry that fails its own checks is reported and the rest go on. */
	const each = <Entry extends ManifestEntry>(
		items: readonly Entry[],
		run: (tx: Tx, entry: Entry) => Effect.Effect<void, SecretFound | WriteRejected>,
	) =>
		Effect.forEach(
			[...new Set(items.map((entry) => entry.tier))],
			(tier) => {
				const group = items.filter((entry) => entry.tier === tier);

				return vault.transact(tier, `migrate ${String(group.length)} items`, (tx) =>
					Effect.forEach(group, (entry) => run(tx, entry), { concurrency: 1, discard: true }),
				);
			},
			{ concurrency: 1, discard: true },
		);

	const exclude = (origin: string, reason: string) =>
		Effect.sync(() => {
			report.excluded.push({ origin: reportOrigin(origin), reason });
		});

	const store = (tx: Tx, source: NewSource, origin: string, onStored: () => void) =>
		tx.putSource(source).pipe(
			Effect.andThen(Effect.sync(onStored)),
			Effect.catchTags({
				SecretFound: (error) => exclude(origin, `secret scan: ${error.rules.join(", ")}`),
				WriteRejected: () => exclude(origin, "invalid record"),
			}),
		);

	// Captures first, in every tier, so a document's citations resolve only to sources that made it in.
	yield* each(
		entries.filter((entry): entry is CaptureEntry => entry.type === "capture"),
		(tx, entry) => {
			const refs = entry.refs ?? [];

			const excerpt = entry.excerpt === undefined ? [] : [entry.excerpt];

			if (outOfScope([entry.title, entry.url, ...refs, ...excerpt].join("\n"))) {
				report.excluded.push({ origin: entry.id, reason: "out of scope" });

				return Effect.void;
			}

			// Named by ID if refused: the URL may be the very thing the scan refused.
			return store(
				tx,
				{
					id: entry.id,
					kind: "capture",
					title: oneLine(entry.title) || entry.url,
					url: entry.url,
					sourceType: "PRIMARY",
					captured: entry.captured,
					// Keyed by its text, as a quoted passage is: a later excerpt is added beside this one.
					passages: Object.fromEntries(excerpt.map((text) => [passageId(text), text])),
				},
				entry.id,
				() => {
					report.migrated.push({ origin: entry.url, id: entry.id, passages: excerpt.length });

					for (const key of [entry.url, ...refs].flatMap(referenceKeys)) {
						saved.set(key, { id: entry.id, tier: entry.tier });
					}
				},
			);
		},
	);

	const view = yield* vault.view;
	const documents = entries
		.filter((entry): entry is DocumentEntry => entry.type === "document")
		.filter((entry) => {
			if (documentHead(view, entry).valid) {
				return true;
			}

			report.excluded.push({
				origin: reportOrigin(entry.origin),
				reason: "invalid document version chain",
			});

			return false;
		});

	yield* each(documents, (tx, entry) =>
		Effect.gen(function* () {
			const { origin } = entry;
			const body = yield* fs.readFileString(entry.file).pipe(Effect.option);

			if (Option.isNone(body)) {
				report.excluded.push({ origin: reportOrigin(origin), reason: "unreadable" });

				return;
			}

			const frontmatter = FRONTMATTER.exec(body.value)?.[0] ?? "";
			const all = sections(body.value).map((section, index) => ({
				...section,
				id: `s${String(index + 1)}`,
			}));
			const kept = all.filter((section) => !outOfScope(`${section.heading}\n${section.text}`));
			const dropped = all.length - kept.length;

			if (outOfScope(`${origin}\n${entry.title}\n${frontmatter}`) || dropped > passingSections) {
				report.excluded.push({ origin: reportOrigin(origin), reason: "out of scope" });

				return;
			}

			if (kept.length === 0) {
				report.excluded.push({ origin: reportOrigin(origin), reason: "empty document" });

				return;
			}

			const cites: string[] = [];
			const unsaved: string[] = [];

			for (const url of citedUrls(kept.map((section) => section.text).join("\n"))) {
				// A shared document may cite only shared captures; a private one, its own tier's too.
				const id = referenceKeys(url)
					.map((key) => saved.get(key))
					.find(
						(found) =>
							found !== undefined && (found.tier === entry.tier || found.tier === "shared"),
					)?.id;

				if (id === undefined) {
					unsaved.push(url);
				}

				cites.push(id ?? url);
			}

			const chain = documentHead(tx, entry);

			if (!chain.valid) {
				report.excluded.push({
					origin: reportOrigin(origin),
					reason: "invalid document version chain",
				});

				return;
			}

			const { root, head: current } = chain;
			const passages = Object.fromEntries(kept.map((section) => [section.id, section.text]));
			const headings = Object.fromEntries(
				kept
					.filter((section) => section.heading !== "")
					.map((section) => [section.id, section.heading]),
			);
			const citations = [...new Set(cites)];

			const unchanged =
				current?.title === oneLine(entry.title) &&
				current.sourceType === entry.sourceType &&
				isDeepStrictEqual(documentSections(current.passages), passages) &&
				isDeepStrictEqual(documentSections(current.headings ?? {}), headings) &&
				isDeepStrictEqual(current.cites ?? [], citations);
			let id = root;

			if (current !== undefined) {
				id = current.id;

				if (!unchanged) {
					do {
						id = `doc-${randomBytes(12).toString("hex")}`;
					} while (tx.locate(id) !== undefined);
				}
			}

			if (!unchanged) {
				const candidate: NewSource = {
					id,
					kind: entry.kind,
					title: oneLine(entry.title),
					origin,
					sourceType: entry.sourceType,
					captured: entry.captured,
					passages,
					headings,
					...(citations.length === 0 ? {} : { cites: citations }),
				};

				if (!Schema.is(Source)({ ...candidate, status: "active", agent: vault.agent })) {
					yield* exclude(origin, "invalid record");

					return;
				}

				const accepted = yield* tx.putSource(candidate).pipe(
					Effect.as(true),
					Effect.catchTag("SecretFound", (error) =>
						exclude(origin, `secret scan: ${error.rules.join(", ")}`).pipe(Effect.as(false)),
					),
				);

				if (!accepted) {
					return;
				}

				if (current !== undefined) {
					yield* tx.setSourceStatus(current.id, {
						status: "replaced",
						replacedBy: id,
						reason: "document re-synced",
					});

					yield* tx.flagDependents;
				}
			}

			report.migrated.push({ origin, id, passages: kept.length });

			if (dropped > 0) {
				report.partial.push({ origin, sectionsExcluded: dropped });
			}

			for (const ref of unsaved) {
				report.unsavedCitations.push({ ref, citedBy: origin });
			}
		}),
	);

	yield* vault.reconcile("reconcile migrated documents");

	return report;
});
