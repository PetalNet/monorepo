import { createHash } from "node:crypto";

import { Effect, FileSystem, Option, Schema } from "effect";

import { Vault } from "./engine.ts";
import type { NewSource, Tx } from "./engine.ts";
import { SourceType, Text, Tier, oneLine } from "./schema.ts";

const Timestamp = Text.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/));

/**
 * One line of a migration manifest. A `document` is a lab-written file copied in verbatim as a
 * source with one passage per heading section. Originals are only read.
 */
export const ManifestEntry = Schema.Struct({
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
});
export type ManifestEntry = typeof ManifestEntry.Type;

export interface MigrationReport {
	readonly migrated: { origin: string; id: string; passages: number }[];
	/** Left out on purpose. Paths and reasons only, never content. */
	readonly excluded: { origin: string; reason: string }[];
	/** Documents migrated without the few sections that matched the deny list. */
	readonly partial: { origin: string; sectionsExcluded: number }[];
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
	const report: MigrationReport = { migrated: [], excluded: [], partial: [] };
	const denied = denyKeywords.map(fold).filter(Boolean);
	const outOfScope = (text: string) => denied.some((keyword) => fold(text).includes(keyword));

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
					Effect.forEach(group, (entry) => run(tx, entry), { discard: true }),
				);
			},
			{ discard: true },
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

	yield* each(entries, (tx, entry) =>
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
				},
				origin,
				() => {
					report.migrated.push({ origin, id, passages: kept.length });

					if (dropped > 0) {
						report.partial.push({ origin, sectionsExcluded: dropped });
					}
				},
			);
		}),
	);

	return report;
});
