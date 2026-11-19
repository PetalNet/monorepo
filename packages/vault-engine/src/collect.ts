import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, FileSystem, Option, Schema } from "effect";

import type { ManifestEntry } from "./migrate.ts";
import { Text, Tier, oneLine } from "./schema.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * Where the lab's written content lives, read by `vault collect` to build a migration manifest.
 * Every input is optional and only read.
 */
export const CollectSpec = Schema.Struct({
	/** The most characters one document may contribute (default 100 000); the rest is cut. */
	maxChars: Schema.optionalKey(PositiveInt),
	/**
	 * A gallery database: table `artifacts(slug, title, kind, content, visibility, updated_at)`. A
	 * `shared` row goes to the `shared` tier and a `private` row to `personal`.
	 */
	gallery: Schema.optionalKey(
		Schema.Struct({
			db: Text,
			/** Prefix of each row's origin: `<origin>/<slug>`. */
			origin: Text,
		}),
	),
	/** Folders of markdown notes; the `.md` files directly inside each are taken. */
	notes: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				dir: Text,
				/** Prefix of each note's origin: `<origin>/<file name>`. Name the original, not a copy. */
				origin: Text,
				kind: Schema.Literals(["research", "memory", "context"]),
				tier: Tier,
			}),
		),
	),
	/** A vault-cite index: `sources(id, metadata)` and the extracted text in `evidence(id, text)`. */
	cite: Schema.optionalKey(
		Schema.Struct({
			db: Text,
			tier: Tier,
			/** The most characters of a source's extracted text kept as its excerpt (default 2 000). */
			excerptChars: Schema.optionalKey(PositiveInt),
		}),
	),
});
export type CollectSpec = typeof CollectSpec.Type;

interface CollectReport {
	/** Manifest entries written, by `<kind>/<tier>`. */
	readonly entries: Record<string, number>;
	/** Documents over the cap, stored without their tail. Origins and sizes only, never content. */
	readonly cut: { origin: string; chars: number; kept: number }[];
	/** Gallery pages with no text outside scripts and media, stored as their title alone. */
	readonly titleOnly: string[];
	/** Saved sources with no extracted text; stored, but no passage makes them recallable. */
	readonly withoutText: string[];
	/** Inputs left out of the manifest, with the reason. */
	readonly skipped: { origin: string; reason: string }[];
}

const DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=._-]+)*,[^\s"'<>)\\]*/gi;
// A tag ends at the first `>` outside its quoted attribute values.
const ATTRIBUTES = String.raw`((?:"[^"]*"|'[^']*'|[^>"'])*)`;
// A comment, script or style left open swallows the rest of the page, as it does in a browser.
const RAW_TEXT = new RegExp(
	String.raw`<!--[\s\S]*?(?:-->|$)|<(script|style)\b${ATTRIBUTES}>[\s\S]*?(?:<\/\1\s*>|$)`,
	"gi",
);
const ANY_TAG = new RegExp(String.raw`<(\/?)([a-z][a-z0-9-]*)\b${ATTRIBUTES}>`, "gi");
const HREF = /\bhref\s*=\s*(["'])(https?:\/\/[^"'\s]+)\1/i;
// The patterns below read tags that `bare` has already stripped of every attribute but a link's.
const EMBEDDED =
	/<(svg|template|noscript|canvas|audio|video|object|iframe|head|select|math)>[\s\S]*?<\/\1>/gi;
const HEADING = /<h([1-6])>([\s\S]*?)<\/h\1>/gi;
const LINK = /<a href="([^"]*)">([\s\S]*?)<\/a>/gi;
const BLOCK =
	/<\/?(?:p|div|section|article|header|footer|main|nav|aside|ul|ol|table|thead|tbody|tr|pre|blockquote|details|summary|figure|figcaption|dl|dt|dd|form|fieldset|address|title|body|html|hr)>/gi;
const TAG = /<\/?[a-z][^>]*>|<![^>]*>/gi;

/** Every tag without its attributes, so nothing inside an attribute value can pass for text. */
const bare = (html: string) =>
	html.replaceAll(ANY_TAG, (_whole, slash, name, attributes) => {
		const tag = String(name).toLowerCase();
		const href = tag === "a" && slash === "" ? HREF.exec(String(attributes))?.[2] : undefined;

		return href === undefined ? `<${String(slash)}${tag}>` : `<a href="${href}">`;
	});

const ENTITIES: Record<string, string> = {
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	middot: "·",
	bull: "•",
	rarr: "→",
	larr: "←",
	times: "×",
	copy: "©",
	amp: "&",
};

const decodeEntities = (text: string) =>
	text.replaceAll(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, decimal, hex, name) => {
		const code =
			decimal === undefined
				? hex === undefined
					? undefined
					: Number.parseInt(String(hex), 16)
				: Number(decimal);

		if (code !== undefined) {
			// Not a character: zero, half a surrogate pair, or past the end of Unicode.
			return code === 0 || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)
				? ""
				: String.fromCodePoint(code);
		}

		return ENTITIES[String(name).toLowerCase()] ?? whole;
	});

const withoutDataUris = (text: string) => text.replaceAll(DATA_URI, "");

/**
 * Reduces an HTML page to the markdown a reader would want from it: headings, text, list items and
 * links. Scripts, styles, comments, inline data and embedded media are dropped with their content.
 */
function htmlToMarkdown(html: string): string {
	const inline = (inner: string) => oneLine(inner.replaceAll(TAG, " "));

	return decodeEntities(
		withoutDataUris(bare(html.replaceAll(RAW_TEXT, " ")))
			.replaceAll(EMBEDDED, " ")
			.replaceAll(HEADING, (_whole, level, inner) => {
				const text = inline(String(inner));

				return text === "" ? "\n\n" : `\n\n${"#".repeat(Number(level))} ${text}\n\n`;
			})
			.replaceAll(LINK, (_whole, url, inner) => {
				const text = inline(String(inner));

				return text === "" || text === url ? String(url) : `[${text}](${String(url)})`;
			})
			.replaceAll("<br>", "\n")
			.replaceAll("<li>", "\n- ")
			.replaceAll(/<\/t[dh]>/g, " | ")
			.replaceAll(BLOCK, "\n\n")
			.replaceAll(TAG, ""),
	)
		.split("\n")
		.map((line) => line.replaceAll(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replaceAll(/^-\n+/gm, "- ")
		.replaceAll(/\n{3,}/g, "\n\n")
		.trim();
}

/** The start of a text, up to `max` characters, ending at a line (or a word) where it can. */
function head(text: string, max: number, boundary: "\n" | " "): string {
	if (text.length <= max) {
		return text;
	}

	const cut = text.slice(0, max);
	const at = boundary === "\n" ? cut.lastIndexOf("\n") : cut.search(/\s\S*$/);
	// Never end on half of a surrogate pair.
	const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;

	return (at > max / 2 ? cut.slice(0, at) : whole).trimEnd();
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A note's title: its first top-level heading, else its frontmatter `title` or `name`, else its
 * file name.
 */
function noteTitle(body: string, file: string): string {
	let fenced = false;

	for (const line of body.split("\n")) {
		if (/^\s*(?:```|~~~)/.test(line)) {
			fenced = !fenced;
		}

		const heading = fenced ? null : /^#\s+(.+?)\s*#*$/.exec(line);

		if (heading?.[1] !== undefined) {
			return oneLine(heading[1]);
		}
	}

	const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1] ?? "";
	const named = /^(?:title|name):\s*["']?(.+?)["']?\s*$/m.exec(frontmatter)?.[1];

	return oneLine(named ?? "") || path.basename(file, ".md");
}

const GalleryRow = Schema.Struct({
	slug: Text,
	title: Schema.NullOr(Schema.String),
	kind: Schema.Literals(["markdown", "html", "interactive"]),
	content: Schema.NullOr(Schema.String),
	// Any other visibility is refused, so a row never lands in a wider tier by default.
	visibility: Schema.Literals(["shared", "private"]),
	updated_at: Schema.String,
});

/** Vault-cite's source metadata, as far as a capture entry needs it. */
const CiteSource = Schema.Struct({
	id: Schema.String,
	url: Text,
	title: Schema.optionalKey(Schema.NullOr(Schema.String)),
	fetched_at: Schema.String,
	access_status: Schema.Literal("SAVED"),
	canonical_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	citation_ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
	final_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** SQLite's `YYYY-MM-DD HH:MM:SS` is UTC; anything `Date` cannot read is no timestamp. */
function timestamp(value: string): string | undefined {
	const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value}Z` : value);

	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const readOnly = (file: string) =>
	Effect.acquireRelease(
		Effect.sync(() => new DatabaseSync(file, { readOnly: true })),
		(db) =>
			Effect.sync(() => {
				db.close();
			}),
	);

/**
 * Reads the inputs a spec names and writes `<out>/manifest.jsonl` for `vault migrate`, converted
 * and cut documents under `<out>/documents`, and the report as `<out>/collect.json`. The same
 * inputs always give the same manifest and files, so collecting and migrating again converges.
 */
export const collect = Effect.fnUntraced(function* (spec: CollectSpec, out: string) {
	const fs = yield* FileSystem.FileSystem;
	const maxChars = spec.maxChars ?? 100_000;
	const entries: ManifestEntry[] = [];
	const report: CollectReport = {
		entries: {},
		cut: [],
		titleOnly: [],
		withoutText: [],
		skipped: [],
	};
	const staged = path.join(out, "documents");

	yield* fs.makeDirectory(staged, { recursive: true });

	const origins = new Set<string>();
	/** An origin is a document's identity: a second input claiming one is left out, not merged. */
	const repeated = (origin: string) => {
		if (!origins.has(origin)) {
			origins.add(origin);

			return false;
		}

		report.skipped.push({ origin, reason: "repeated origin" });

		return true;
	};

	const add = (entry: ManifestEntry) => {
		const key = `${entry.type === "capture" ? "capture" : entry.kind}/${entry.tier}`;

		entries.push(entry);
		report.entries[key] = (report.entries[key] ?? 0) + 1;
	};

	/** Applies the cap; the cut text says so where it ends, and the report says how much went. */
	const capped = (origin: string, text: string) => {
		if (text.length <= maxChars) {
			return text;
		}

		const kept = head(text, maxChars, "\n");

		report.cut.push({ origin, chars: text.length, kept: kept.length });

		return `${kept}\n\n[Cut here: the first ${String(kept.length)} of ${String(text.length)} characters are stored.]\n`;
	};

	const stage = Effect.fnUntraced(function* (kind: string, origin: string, text: string) {
		const file = path.join(staged, `${kind}-${sha256(origin).slice(0, 16)}.md`);

		yield* fs.writeFileString(file, text);

		return file;
	});

	if (spec.gallery !== undefined) {
		const gallery = spec.gallery;

		yield* Effect.scoped(
			Effect.gen(function* () {
				const db = yield* readOnly(gallery.db);
				// One row at a time: a page can be megabytes of embedded media.
				const row = db.prepare(
					"SELECT slug, title, kind, CAST(content AS TEXT) AS content, visibility, updated_at FROM artifacts WHERE rowid = ?",
				);

				// `AS n`: where the table has an integer primary key, `rowid` comes back under that name.
				for (const { n } of db.prepare("SELECT rowid AS n FROM artifacts ORDER BY slug").all()) {
					const found = Schema.decodeUnknownOption(GalleryRow)(row.get(Number(n)));
					const captured = Option.isSome(found) ? timestamp(found.value.updated_at) : undefined;

					if (Option.isNone(found) || captured === undefined) {
						report.skipped.push({
							origin: `${gallery.origin}/row ${String(n)}`,
							reason: "unreadable row",
						});

						continue;
					}

					const { slug, kind, visibility } = found.value;
					const origin = `${gallery.origin}/${slug}`;

					if (repeated(origin)) {
						continue;
					}

					const title = oneLine(found.value.title ?? "") || slug;
					const content = found.value.content ?? "";
					let text = withoutDataUris(content);

					if (kind !== "markdown") {
						const body = htmlToMarkdown(content);

						if (body === "") {
							report.titleOnly.push(origin);
						}

						// The title leads, so a page of nothing but script still names itself.
						text = `# ${title}\n\n${body}\n`;
					}

					add({
						type: "document",
						kind: "gallery",
						tier: visibility === "shared" ? "shared" : "personal",
						origin,
						file: yield* stage("gallery", origin, capped(origin, text)),
						title,
						captured,
						sourceType: "DERIVED",
					});
				}
			}),
		);
	}

	for (const notes of spec.notes ?? []) {
		const names = (yield* fs.readDirectory(notes.dir)).filter((name) => name.endsWith(".md"));

		for (const name of names.toSorted()) {
			const file = path.join(notes.dir, name);
			const origin = `${notes.origin}/${name}`;
			const info = yield* fs.stat(file);
			const modified = Option.getOrUndefined(info.mtime);

			if (info.type !== "File" || modified === undefined) {
				report.skipped.push({ origin, reason: "not a regular file" });

				continue;
			}

			if (repeated(origin)) {
				continue;
			}

			const text = yield* fs.readFileString(file);
			const kept = capped(origin, text);

			add({
				type: "document",
				kind: notes.kind,
				tier: notes.tier,
				origin,
				// A note within the cap is read where it lies.
				file: kept === text ? file : yield* stage(notes.kind, origin, kept),
				title: noteTitle(text, name),
				captured: modified.toISOString(),
				sourceType: "DERIVED",
			});
		}
	}

	if (spec.cite !== undefined) {
		const cite = spec.cite;

		yield* Effect.scoped(
			Effect.gen(function* () {
				const db = yield* readOnly(cite.db);
				const evidence = db.prepare("SELECT text FROM evidence WHERE id = ?");

				for (const { id, metadata } of db
					.prepare("SELECT id, metadata FROM sources ORDER BY id")
					.all()) {
					const found = Schema.decodeUnknownOption(Schema.fromJsonString(CiteSource))(metadata);
					const captured = Option.isSome(found) ? timestamp(found.value.fetched_at) : undefined;

					if (
						Option.isNone(found) ||
						captured === undefined ||
						found.value.id !== id ||
						!/^src-[a-f0-9]{20}$/.test(found.value.id)
					) {
						report.skipped.push({ origin: String(id), reason: "unreadable source record" });

						continue;
					}

					const source = found.value;
					const text = evidence.get(source.id)?.["text"];
					const excerpt = head(
						typeof text === "string" ? text.trim() : "",
						cite.excerptChars ?? 2000,
						" ",
					);

					if (excerpt === "") {
						report.withoutText.push(source.id);
					}

					add({
						type: "capture",
						tier: cite.tier,
						id: source.id,
						title: source.title ?? "",
						url: source.url,
						captured,
						refs: [source.canonical_id, source.citation_ref, source.final_url].filter(
							(ref): ref is string => typeof ref === "string" && ref !== "" && ref !== source.url,
						),
						...(excerpt === "" ? {} : { excerpt }),
					});
				}
			}),
		);
	}

	yield* fs.writeFileString(
		path.join(out, "manifest.jsonl"),
		entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
	);

	yield* fs.writeFileString(path.join(out, "collect.json"), JSON.stringify(report, null, 1));

	return report;
});
