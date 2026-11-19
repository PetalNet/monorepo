import { createHash } from "node:crypto";

import { Effect, FileSystem, Option, Schema } from "effect";

import { Vault } from "./engine.ts";
import type { NewSource, Tx } from "./engine.ts";
import { SourceType, Text, Tier, oneLine } from "./schema.ts";
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
		run: (tx: Tx, entry: Entry) => Effect.Effect<void>,
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
			report.excluded.push({ origin, reason });
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

			if (outOfScope([entry.title, entry.url, ...refs].join("\n"))) {
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
					passages: {},
				},
				entry.id,
				() => {
					report.migrated.push({ origin: entry.url, id: entry.id, passages: 0 });

					for (const key of [entry.url, ...refs].flatMap(referenceKeys)) {
						saved.set(key, { id: entry.id, tier: entry.tier });
					}
				},
			);
		},
	);

	yield* each(
		entries.filter((entry): entry is DocumentEntry => entry.type === "document"),
		(tx, entry) =>
			Effect.gen(function* () {
				const { origin } = entry;
				const body = yield* fs.readFileString(entry.file).pipe(Effect.option);

				if (Option.isNone(body)) {
					report.excluded.push({ origin, reason: "unreadable" });

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
					report.excluded.push({ origin, reason: "out of scope" });

					return;
				}

				if (kept.length === 0) {
					report.excluded.push({ origin, reason: "empty document" });

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

				const id = `doc-${createHash("sha256").update(`${entry.kind}\n${origin}`).digest("hex").slice(0, 16)}`;
				const passages = Object.fromEntries(kept.map((section) => [section.id, section.text]));
				const before = tx.state.sources[id]?.passages ?? {};

				// Passages are immutable: a document edited after it was migrated keeps its first version.
				if (Object.entries(passages).some(([key, text]) => key in before && before[key] !== text)) {
					report.excluded.push({
						origin,
						reason: "changed since it was migrated; the vault keeps the migrated version",
					});

					return;
				}

				yield* store(
					tx,
					{
						id,
						kind: entry.kind,
						title: oneLine(entry.title),
						origin,
						sourceType: entry.sourceType,
						captured: entry.captured,
						passages,
						headings: Object.fromEntries(
							kept
								.filter((section) => section.heading !== "")
								.map((section) => [section.id, section.heading]),
						),
						...(cites.length === 0 ? {} : { cites: [...new Set(cites)] }),
					},
					// An origin that itself trips the scan is withheld from the report.
					secretRules([origin]).length === 0 ? origin : "(origin withheld by the secret scan)",
					() => {
						report.migrated.push({ origin, id, passages: kept.length });

						if (dropped > 0) {
							report.partial.push({ origin, sectionsExcluded: dropped });
						}

						// Reported only once the document passed the secret scan, so the report cannot carry a
						// URL the scan would have refused.
						for (const ref of unsaved) {
							report.unsavedCitations.push({ ref, citedBy: origin });
						}
					},
				);
			}),
	);

	return report;
});
