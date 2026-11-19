import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { collect } from "../src/collect.ts";
import type { CollectSpec } from "../src/collect.ts";
import { ManifestEntry, migrate } from "../src/migrate.ts";
import { lint, project } from "../src/project.ts";
import { recallPassages, reindex } from "../src/recall.ts";
import { OTHER, SOURCE, readText, state, tempDir, test, writeText } from "./tools.ts";

const PIXELS = `data:image/png;base64,${"iVBORw0KGgo".repeat(40_000)}`;

const PAGE = `<!doctype html><html><head><title>Tab title</title><style>h1 { color: red }</style></head>
<body><!-- a comment -->
<h1 class="top">Kiln <em>schedule</em></h1>
<p>Bisque firing runs at cone&nbsp;04 &amp; takes <b>nine</b> hours.</p>
<img src="${PIXELS}" alt="chart">
<svg viewBox="0 0 1 1"><text>vector label</text></svg>
<h2>Glaze</h2>
<ul><li>Celadon over <a href="https://example.org/celadon">the celadon notes</a></li><li>Tenmoku</li></ul>
<div data-payload="x>smuggled">Unloading takes a day.</div>
<button onclick="if(a>b){handler()}">Fire</button>
<script>const hidden = "scripted words";</script>
<p>After the script.</p>
<script>let unclosed = "never shown";
<p>Swallowed by the open script.</p>
</body></html>`;

/** A gallery database shaped like the real one, with the rows a test names. */
const galleryDb = (
	file: string,
	rows: readonly { slug: string; kind: string; content: string; visibility: string }[],
) =>
	Effect.sync(() => {
		const db = new DatabaseSync(file);

		db.exec(
			"CREATE TABLE artifacts(id INTEGER PRIMARY KEY, slug TEXT, title TEXT, kind TEXT, content TEXT, visibility TEXT, collection TEXT, created_at TEXT, updated_at TEXT)",
		);

		const insert = db.prepare("INSERT INTO artifacts VALUES(NULL,?,?,?,?,?,NULL,?,?)");

		for (const row of rows) {
			insert.run(
				row.slug,
				`Title of ${row.slug}`,
				row.kind,
				row.content,
				row.visibility,
				"2026-11-01 08:00:00",
				"2026-11-02 09:30:00",
			);
		}

		db.close();
	});

/** A vault-cite index with the given sources; a source with no text has an empty evidence row. */
const citeDb = (file: string, sources: readonly { id: string; title: string; text: string }[]) =>
	Effect.sync(() => {
		const db = new DatabaseSync(file);

		db.exec(
			"CREATE TABLE sources(id TEXT PRIMARY KEY, metadata TEXT NOT NULL); CREATE VIRTUAL TABLE evidence USING fts5(id UNINDEXED, title, authors, canonical_id, url, text)",
		);

		for (const source of sources) {
			db.prepare("INSERT INTO sources VALUES(?,?)").run(
				source.id,
				JSON.stringify({
					id: source.id,
					url: `https://example.org/${source.id}`,
					title: source.title,
					fetched_at: "2026-10-21T13:10:13.215Z",
					access_status: "SAVED",
					canonical_id: `arxiv:2312.${source.id.slice(-5)}`,
					final_url: `https://example.org/${source.id}`,
				}),
			);

			db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?)").run(
				source.id,
				source.title,
				"",
				"",
				"",
				source.text,
			);
		}

		db.close();
	});

/** Collects into a fresh folder and migrates the manifest it wrote, as the two commands do. */
const load = (spec: CollectSpec) =>
	Effect.gen(function* () {
		const out = yield* tempDir;
		const collected = yield* collect(spec, out);
		const entries = yield* Schema.decodeEffect(Schema.Array(Schema.fromJsonString(ManifestEntry)))(
			(yield* readText(out, "manifest.jsonl")).split("\n").filter(Boolean),
		);
		const migrated = yield* migrate(entries, []);

		yield* reindex;

		return { collected, migrated, entries, out };
	});

const hit = (query: string) =>
	Effect.map(recallPassages(query, { k: 1 }), (hits) => {
		const found = hits[0];

		return found === undefined
			? undefined
			: { kind: found.kind, tier: found.tier, title: found.title, text: found.text };
	});

/** What a gallery page becomes: the staged file a one-row gallery collects to, after its title. */
const converted = (html: string) =>
	Effect.gen(function* () {
		const dir = yield* tempDir;
		const db = path.join(dir, "gallery.db");

		yield* galleryDb(db, [{ slug: "page", kind: "html", content: html, visibility: "shared" }]);
		yield* collect({ gallery: { db, origin: "gallery" } }, dir);

		const [line = ""] = (yield* readText(dir, "manifest.jsonl")).split("\n");
		const entry = yield* Schema.decodeEffect(Schema.fromJsonString(ManifestEntry))(line);
		const text = entry.type === "document" ? yield* readText(entry.file) : "";

		return text.replace("# Title of page\n\n", "").trimEnd();
	});

describe("a collected gallery page", () => {
	test("keeps headings, text, list items and links, and drops scripts, styles, comments and media", () =>
		Effect.gen(function* () {
			expect(yield* converted(PAGE)).toBe(
				[
					"# Kiln schedule",
					"Bisque firing runs at cone 04 & takes nine hours.",
					"## Glaze",
					"- Celadon over [the celadon notes](https://example.org/celadon)\n- Tenmoku",
					"Unloading takes a day.",
					"Fire",
					"After the script.",
				].join("\n\n"),
			);
		}));

	test("decodes an escaped tag to text rather than dropping it", () =>
		Effect.gen(function* () {
			expect(yield* converted("<p>Write &lt;script&gt; &#8212; then &#x41;.</p>")).toBe(
				"Write <script> — then A.",
			);
		}));
});

describe("collect", () => {
	test("gallery rows are recalled from the tier their visibility maps to, without embedded data", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const db = path.join(dir, "gallery.db");

			yield* galleryDb(db, [
				{ slug: "kiln", kind: "html", content: PAGE, visibility: "private" },
				{
					slug: "wheel",
					kind: "markdown",
					content: `# Wheel\n\nCentering takes practice.\n\n![photo](${PIXELS})\n`,
					visibility: "shared",
				},
				{
					slug: "toy",
					kind: "interactive",
					content: "<html><body><script>render('app')</script></body></html>",
					visibility: "shared",
				},
				{ slug: "odd", kind: "html", content: "<p>Who may read this?</p>", visibility: "team" },
			]);

			const { collected, migrated, out } = yield* load({ gallery: { db, origin: "gallery" } });

			expect(collected.entries).toEqual({ "gallery/personal": 1, "gallery/shared": 2 });
			expect(collected.titleOnly).toEqual(["gallery/toy"]);
			expect(collected.skipped).toEqual([{ origin: "gallery/row 4", reason: "unreadable row" }]);
			expect(migrated.excluded).toEqual([]);

			expect(yield* hit("bisque cone")).toEqual({
				kind: "gallery",
				tier: "personal",
				title: "Title of kiln",
				text: "# Kiln schedule\n\nBisque firing runs at cone 04 & takes nine hours.",
			});

			expect((yield* hit("centering practice"))?.tier).toBe("shared");
			expect((yield* hit("toy"))?.text).toBe("# Title of toy");
			expect(yield* hit("hidden unclosed swallowed vector smuggled handler")).toBeUndefined();

			const stored = JSON.stringify([yield* state("shared"), yield* state("personal")]);

			expect(stored).not.toContain("iVBORw0KGgo");
			yield* project(path.join(out, "obsidian"));
			expect((yield* lint(path.join(out, "obsidian"))).problems).toEqual([]);
		}));

	test("a document over the cap is stored without its tail and reported by size only", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const lines = Array.from({ length: 60 }, (_, index) => `Line ${String(index)} of the log.`);

			yield* writeText(path.join(dir, "long.md"), `# Long\n\n${lines.join("\n")}\n`);
			yield* writeText(path.join(dir, "short.md"), "---\nname: short-note\n---\nBrief.\n");
			yield* writeText(path.join(dir, "ignored.txt"), "Not a note.\n");

			const { collected, entries } = yield* load({
				maxChars: 400,
				notes: [{ dir, origin: "notes", kind: "memory", tier: "agent" }],
			});

			expect(collected.entries).toEqual({ "memory/agent": 2 });
			expect(collected.cut).toEqual([{ origin: "notes/long.md", chars: 1198, kept: 397 }]);
			expect(entries.map((entry) => entry.title)).toEqual(["Long", "short-note"]);

			const long = Object.values((yield* state("agent")).sources).find(
				(source) => source.origin === "notes/long.md",
			);
			const text = Object.values(long?.passages ?? {}).join("\n");

			expect(text).toContain("Line 19 of the log.");
			expect(text).not.toContain("Line 20 of the log.");
			expect(text).toContain("[Cut here: the first 397 of 1198 characters are stored.]");
			expect((yield* hit("brief"))?.kind).toBe("memory");
		}));

	test("a saved source is recalled by the start of its text; one without text is stored and reported", () =>
		Effect.gen(function* () {
			const db = path.join(yield* tempDir, "index.sqlite");
			const words = Array.from({ length: 30 }, (_, index) => `word${String(index)}`).join(" ");

			yield* citeDb(db, [
				{ id: SOURCE, title: "Dense retrieval", text: `Propositions beat passages. ${words}` },
				{ id: OTHER, title: "Scanned paper", text: "" },
			]);

			const { collected, migrated } = yield* load({
				cite: { db, tier: "personal", excerptChars: 60 },
			});

			expect(collected.entries).toEqual({ "capture/personal": 2 });
			expect(collected.withoutText).toEqual([OTHER]);
			expect(migrated.migrated.map((item) => item.passages)).toEqual([1, 0]);

			expect(yield* hit("propositions")).toEqual({
				kind: "capture",
				tier: "personal",
				title: "Dense retrieval",
				text: "Propositions beat passages. word0 word1 word2 word3 word4",
			});

			expect(Object.keys((yield* state("personal")).sources).toSorted()).toEqual([SOURCE, OTHER]);
		}));

	test("a second input claiming an origin is left out and reported, not merged into the first", () =>
		Effect.gen(function* () {
			const mine = yield* tempDir;
			const theirs = yield* tempDir;

			yield* writeText(path.join(mine, "plan.md"), "Mine alone.\n");
			yield* writeText(path.join(theirs, "plan.md"), "For everyone.\n");

			const { collected } = yield* load({
				notes: [
					{ dir: mine, origin: "notes", kind: "memory", tier: "agent" },
					{ dir: theirs, origin: "notes", kind: "memory", tier: "shared" },
				],
			});

			expect(collected.skipped).toEqual([{ origin: "notes/plan.md", reason: "repeated origin" }]);
			expect(Object.keys((yield* state("shared")).sources)).toEqual([]);
			expect((yield* hit("alone"))?.tier).toBe("agent");
		}));

	test("collecting and migrating the same inputs again changes nothing", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const db = path.join(dir, "gallery.db");
			const cite = path.join(dir, "index.sqlite");

			yield* galleryDb(db, [{ slug: "kiln", kind: "html", content: PAGE, visibility: "shared" }]);
			yield* citeDb(cite, [{ id: SOURCE, title: "Dense retrieval", text: "Propositions win." }]);
			yield* writeText(path.join(dir, "note.md"), "# Note\n\nBody.\n");

			const spec: CollectSpec = {
				gallery: { db, origin: "gallery" },
				notes: [{ dir, origin: "notes", kind: "research", tier: "shared" }],
				cite: { db: cite, tier: "shared" },
			};
			const first = yield* load(spec);
			const before = yield* state("shared");
			const second = yield* load(spec);

			expect(second.migrated.migrated).toEqual(first.migrated.migrated);
			expect(second.migrated.excluded).toEqual([]);
			expect(yield* state("shared")).toEqual(before);
		}));
});
