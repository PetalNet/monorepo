import path from "node:path";

import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";

import { Vault } from "../src/engine.ts";
import { migrate } from "../src/migrate.ts";
import type { ManifestEntry } from "../src/migrate.ts";
import { lint, project } from "../src/project.ts";
import { recallPassages, reindex } from "../src/recall.ts";
import { readText, state, stored, tempDir, test, writeText } from "./tools.ts";

type DocumentEntry = Extract<ManifestEntry, { type: "document" }>;

const document = (file: string, extra: Partial<DocumentEntry> = {}): DocumentEntry => ({
	type: "document",
	kind: "research",
	tier: "shared",
	origin: file,
	file,
	title: path.basename(file),
	captured: "2026-10-18T00:00:00.000Z",
	sourceType: "DERIVED",
	...extra,
});

const file = (dir: string, name: string, body: string) =>
	writeText(path.join(dir, name), body).pipe(Effect.as(path.join(dir, name)));

const source = (id: string) =>
	Effect.flatMap(Vault, (vault) => Effect.map(vault.view, (view) => view.source(id)));

describe("migration", () => {
	test("copies documents in as sources with one passage per section", () =>
		Effect.gen(function* () {
			const body =
				"---\nname: x\n---\nIntro line.\n\n# Findings\nSee https://arxiv.org/abs/2312.06648 and https://example.org/unsaved.\n\n## Detail\nMore.\n";
			const at = yield* file(yield* tempDir, "note-research.md", body);
			const report = yield* migrate([document(at, { title: "Note research" })], []);
			const id = report.migrated.find((item) => item.origin === at)?.id ?? "";
			const migrated = yield* source(id);

			expect(report.migrated).toHaveLength(1);

			expect(migrated?.passages).toEqual({
				s1: "Intro line.",
				s2: "# Findings\nSee https://arxiv.org/abs/2312.06648 and https://example.org/unsaved.",
				s3: "## Detail\nMore.",
			});

			expect(migrated?.headings).toEqual({ s2: "Findings", s3: "Findings > Detail" });
			expect(yield* readText(at)).toBe(body);

			yield* reindex;

			expect((yield* recallPassages("detail"))[0]).toMatchObject({
				source: id,
				passage: "s3",
				heading: "Findings > Detail",
			});

			const out = yield* tempDir;

			yield* project(out);

			const note = yield* readText(path.join(out, `shared/Sources/research/${id}.md`));

			expect(note).toContain("## Detail\nMore.\n\n^s3\n");
			expect(note).toMatch(/\^s1\n[\s\S]*\^s2\n[\s\S]*\^s3\n[\s\S]*## Dependents/);
			expect((yield* lint(out)).problems).toEqual([]);
		}));

	test("excludes out-of-scope and secret-bearing documents by path and stores none of their text", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const secret = `ghp_${"a1B2".repeat(9)}`;
			const entry = (name: string, body: string) =>
				Effect.map(file(dir, name, body), (at) =>
					document(at, { kind: "memory", tier: "agent", sourceType: "DIRECT" }),
				);
			const entries = yield* Effect.all([
				entry("fine.md", "A plain note."),
				entry("Restricted Project plan.md", "# Plan\nNo keyword in the text."),
				entry("about.md", "---\ndescription: the Restricted Project site\n---\nBody."),
				entry(
					"mostly.md",
					"# A\nRestricted Project.\n# B\nrestricted project.\n# C\nRESTRICTED PROJECT.\n# D\nOther.",
				),
				entry(
					"passing.md",
					"# Kept\nUseful text, see https://example.org/kept.\n# Aside\nUsed at the Restricted Project, see https://example.org/dropped.\n# Also kept\nMore.",
				),
				entry("leaky.md", `token ${secret}`),
			]);
			const report = yield* migrate(entries, ["restricted project"], 2);
			const passing = yield* source(
				report.migrated.find((item) => item.origin.endsWith("passing.md"))?.id ?? "",
			);

			expect(report.migrated.map((item) => path.basename(item.origin))).toEqual([
				"fine.md",
				"passing.md",
			]);

			expect(report.excluded).toEqual([
				{ origin: path.join(dir, "Restricted Project plan.md"), reason: "out of scope" },
				{ origin: path.join(dir, "about.md"), reason: "out of scope" },
				{ origin: path.join(dir, "mostly.md"), reason: "out of scope" },
				{ origin: path.join(dir, "leaky.md"), reason: "secret scan: github-pat" },
			]);

			expect(report.partial).toEqual([
				{ origin: path.join(dir, "passing.md"), sectionsExcluded: 1 },
			]);

			expect(Object.keys(passing?.passages ?? {})).toEqual(["s1", "s3"]);
			expect(Object.keys((yield* state("agent")).sources)).toHaveLength(2);

			const history = yield* stored("agent");

			expect(history).not.toContain(secret);
			expect(history).not.toMatch(/restricted project/i);
			expect(history).not.toContain("dropped");
			expect(history).toContain("Useful text");
		}));

	test("excludes a document that mentions a denied subject even once, unless passing mentions are allowed", () =>
		Effect.gen(function* () {
			const at = yield* file(
				yield* tempDir,
				"passing.md",
				"# Kept\nUseful.\n# Aside\nSeen at the Restricted Project.\n",
			);

			expect((yield* migrate([document(at)], ["restricted project"])).excluded).toEqual([
				{ origin: at, reason: "out of scope" },
			]);

			expect((yield* state("shared")).sources).toEqual({});

			expect((yield* migrate([document(at)], ["restricted project"], 1)).partial).toEqual([
				{ origin: at, sectionsExcluded: 1 },
			]);
		}));

	test("matches a denied phrase across line breaks, extra spaces, hyphens, markup and case", () =>
		Effect.gen(function* () {
			const dir = yield* tempDir;
			const writes = [
				"Restricted\nProject",
				"restricted  project",
				"restricted-project",
				"RESTRICTED_PROJECT",
				"RestrictedProjectHQ",
				"restricted **pro**ject",
				"unrelated",
			].map((text, index) => file(dir, `${String(index)}.md`, `About the ${text} plan.\n`));
			const files = yield* Effect.all(writes);
			const report = yield* migrate(
				[...files.map((each) => document(each)), document(path.join(dir, "missing.md"))],
				["restricted project"],
			);

			expect(report.migrated.map((item) => item.origin)).toEqual([files[6]]);

			expect(report.excluded).toEqual([
				...files.slice(0, 6).map((origin) => ({ origin, reason: "out of scope" })),
				{ origin: path.join(dir, "missing.md"), reason: "unreadable" },
			]);
		}));

	test("converges when the same manifest runs twice, and keeps the first version of a changed document", () =>
		Effect.gen(function* () {
			const at = yield* file(yield* tempDir, "a.md", "# One\nFirst version.\n");
			const [first] = (yield* migrate([document(at)], [])).migrated;
			const before = (yield* state("shared")).sources;

			yield* migrate([document(at)], []);
			expect((yield* state("shared")).sources).toEqual(before);

			yield* writeText(at, "# Zero\nInserted.\n# One\nFirst version.\n");

			expect((yield* migrate([document(at)], [])).excluded).toEqual([
				{
					origin: at,
					reason: "changed since it was migrated; the vault keeps the migrated version",
				},
			]);

			expect((yield* source(first?.id ?? ""))?.passages).toEqual({ s1: "# One\nFirst version." });
		}));
});
