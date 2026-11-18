import path from "node:path";

import { describe, expect } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { Vault } from "../src/engine.ts";
import { lint, project } from "../src/project.ts";
import { researchRun } from "../src/research.ts";
import {
	OTHER,
	SOURCE,
	addClaim,
	claimInput,
	readText,
	seed,
	seeded,
	tempDir,
	test,
	vaultAt,
	write,
} from "./tools.ts";

const projected = Effect.gen(function* () {
	const out = yield* tempDir;

	yield* project(out);

	return out;
});
const problems = (out: string) => Effect.map(lint(out), (result) => result.problems);
const odd = (passages: Record<string, string>) =>
	write("shared", (tx) =>
		tx.putSource({
			id: "doc-0000000000000001",
			kind: "research",
			title: "Odd",
			sourceType: "DERIVED",
			captured: "2026-10-18T00:00:00.000Z",
			passages,
		}),
	);
const ODD = "shared/Sources/research/doc-0000000000000001.md";

describe("projection", () => {
	test("writes each claim as one list item with typed wikilinks and a trailing block ID", () =>
		Effect.gen(function* () {
			const claim = yield* write("shared", (tx) =>
				seed(tx).pipe(
					Effect.andThen(
						tx.addClaim({
							...claimInput("Claims retrieve better than passages."),
							verdict: "supported",
						}),
					),
				),
			);
			const out = yield* projected;

			expect(yield* readText(out, "shared/Topics/Note granularity.md")).toContain(
				`## Retrieval unit\n- Claims retrieve better than passages. [supports:: [[${SOURCE}#^p1|Dense X Retrieval]]] [basis:: PRIMARY] [verdict:: supported] ^${claim.id}\n`,
			);

			expect(yield* readText(out, `shared/Sources/capture/${SOURCE}.md`)).toContain(
				"- Proposition indexing raises Recall@5. ^p1",
			);

			expect(yield* problems(out)).toEqual([]);
		}));

	test("lists every dependent claim on its source note, marking stale ones", () =>
		Effect.gen(function* () {
			const claim = yield* write("shared", (tx) =>
				Effect.gen(function* () {
					yield* seed(tx);
					yield* seed(tx, OTHER);

					return yield* tx.addClaim(claimInput("Depends on the source."));
				}),
			);
			const out = yield* projected;

			expect(yield* readText(out, `shared/Sources/capture/${SOURCE}.md`)).toContain(
				`## Dependents\n- [[Note granularity#^${claim.id}]] (supports ^p1, active)\n`,
			);

			expect(yield* readText(out, `shared/Sources/capture/${OTHER}.md`)).toContain(
				"No claim cites this source yet.",
			);

			yield* (yield* Vault).retireSource(SOURCE, {
				status: "replaced",
				replacedBy: OTHER,
				reason: "newer version",
			});

			yield* project(out);

			const note = yield* readText(out, `shared/Sources/capture/${SOURCE}.md`);

			expect(note).toContain("status: replaced");
			expect(note).toContain(`- [[Note granularity#^${claim.id}]] (supports ^p1, active, stale)`);

			expect(yield* readText(out, "shared/Topics/Note granularity.md")).toContain(
				`[stale:: 2026-11-17 ${SOURCE}]`,
			);

			expect(yield* problems(out)).toEqual([]);
		}));

	test("lint reports a claim ID that is lost or duplicated in the projected files", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			const claim = yield* write("shared", (tx) =>
				seed(tx).pipe(Effect.andThen(tx.addClaim(claimInput("Will be tampered with.")))),
			);
			const out = yield* projected;
			const topic = path.join(out, "shared/Topics/Note granularity.md");
			const original = yield* fs.readFileString(topic);

			yield* fs.chmod(topic, 0o644);
			yield* fs.writeFileString(topic, original.replace(` ^${claim.id}`, ""));

			expect(yield* problems(out)).toEqual([
				`claim ${claim.id} is missing from the projection`,
				`shared/Sources/capture/${SOURCE}.md: link to missing block [[Note granularity#^${claim.id}]]`,
			]);

			yield* fs.writeFileString(topic, `${original}- A hand-made copy. ^${claim.id}\n`);

			expect(yield* problems(out)).toEqual([
				`claim ${claim.id} appears in both shared/Topics/Note granularity.md and shared/Topics/Note granularity.md`,
			]);
		}));

	test("reports a hand edit, overwrites it, writes notes read-only and leaves files it does not own alone", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* seeded;

			const out = yield* projected;
			const topic = path.join(out, "shared/Topics/Note granularity.md");
			const generated = yield* fs.readFileString(topic);

			expect((yield* fs.stat(topic)).mode & 0o222).toBe(0);
			yield* fs.chmod(topic, 0o644);
			yield* fs.writeFileString(topic, `${generated}\nAn agent typed here.\n`);
			yield* fs.makeDirectory(path.join(out, ".obsidian"));
			yield* fs.writeFileString(path.join(out, ".obsidian", "app.json"), "{}");
			yield* fs.writeFileString(path.join(out, "My own note.md"), "kept");

			expect((yield* project(out)).overwrittenEdits).toEqual(["shared/Topics/Note granularity.md"]);
			expect(yield* fs.readFileString(topic)).toBe(generated);
			expect(yield* readText(out, "My own note.md")).toBe("kept");
			expect(yield* readText(out, ".obsidian/app.json")).toBe("{}");

			expect((yield* fs.readDirectory(out)).toSorted()).toEqual([
				".obsidian",
				".vault-projection.json",
				"Index.md",
				"My own note.md",
				"shared",
			]);
		}));

	test("removes notes the engine no longer has", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* write("shared", (tx) =>
				Effect.gen(function* () {
					yield* seed(tx);
					yield* tx.putTopic({ id: "t-a", title: "Same Name", summary: "One.", headings: [] });
					yield* tx.putTopic({ id: "t-b", title: "same name", summary: "Two.", headings: [] });

					yield* tx.putTopic({
						id: "t-c",
						title: "Index",
						summary: "Clashes with the vault index.",
						headings: [],
					});

					yield* tx.putTopic({
						id: "t-d",
						title: ".hidden",
						summary: "Leading dot.",
						headings: [],
					});
				}),
			);

			const out = yield* projected;

			expect((yield* fs.readDirectory(path.join(out, "shared/Topics"))).toSorted()).toEqual([
				"Index (t-c).md",
				"Note granularity.md",
				"Same Name.md",
				"hidden.md",
				"same name (t-b).md",
			]);

			const other = yield* vaultAt();

			yield* write("shared", seed).pipe(Effect.provideService(Vault, other));

			expect((yield* project(out).pipe(Effect.provideService(Vault, other))).removed).toBe(4);

			expect(yield* fs.readDirectory(path.join(out, "shared/Topics"))).toEqual([
				"Note granularity.md",
			]);
		}));

	test("replaces a symlinked folder in the vault instead of writing or removing through it", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* seeded;

			const out = yield* tempDir;
			const elsewhere = yield* tempDir;

			yield* fs.makeDirectory(path.join(elsewhere, "Topics"));
			yield* fs.writeFileString(path.join(elsewhere, "Topics", "Old.md"), "someone else's");
			yield* fs.symlink(elsewhere, path.join(out, "shared"));
			yield* fs.symlink(elsewhere, path.join(out, "agent"));

			yield* fs.writeFileString(
				path.join(out, ".vault-projection.json"),
				JSON.stringify({
					"agent/Topics/Old.md": "",
					"shared/Topics/Old.md": "",
					"../docs/shared.loro": "",
				}),
			);

			yield* project(out);

			expect(
				(yield* fs.readDirectory(elsewhere, { recursive: true })).toSorted((a, b) =>
					a.localeCompare(b),
				),
			).toEqual(["Topics", path.join("Topics", "Old.md")]);

			expect(yield* readText(elsewhere, "Topics/Old.md")).toBe("someone else's");
			expect(yield* fs.exists((yield* Vault).file("shared"))).toBe(true);
			expect((yield* fs.stat(path.join(out, "shared"))).type).toBe("Directory");
			expect(yield* fs.exists(path.join(out, "agent"))).toBe(false);
			expect(yield* problems(out)).toEqual([]);
		}));

	test("promotes a claim to its own note once three other topics link to it", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			const hub = yield* write("shared", (tx) =>
				seed(tx).pipe(Effect.andThen(tx.addClaim(claimInput("A claim many topics build on.")))),
			);
			const linkFrom = (n: number) =>
				write("shared", (tx) =>
					Effect.gen(function* () {
						yield* tx.putTopic({
							id: `t-other-${String(n)}`,
							title: `Other ${String(n)}`,
							summary: "Another topic.",
							headings: [],
						});

						yield* tx.addClaim({
							...claimInput(`Builds on the hub claim, ${String(n)}.`),
							topic: `t-other-${String(n)}`,
							links: [...claimInput("").links, { rel: "supports", target: hub.id }],
						});
					}),
				);

			yield* linkFrom(1);
			yield* linkFrom(2);

			const out = yield* projected;

			expect(yield* fs.exists(path.join(out, `shared/Claims/${hub.id}.md`))).toBe(false);

			yield* linkFrom(3);
			yield* project(out);

			expect(yield* readText(out, `shared/Claims/${hub.id}.md`)).toContain(
				`![[Note granularity#^${hub.id}]]`,
			);

			expect(yield* problems(out)).toEqual([]);
		}));
});

describe("projected text", () => {
	test("keeps later passages and the Dependents list visible after a passage that opens a fence, comment or tag", () =>
		Effect.gen(function* () {
			yield* seeded;

			yield* odd({
				s1: "````text\nnever closed",
				s2: "<!-- never closed",
				s3: "%% never closed",
				s4: "<pre>",
				s5: "Plain.",
			});

			const out = yield* projected;
			const note = yield* readText(out, ODD);

			expect(note).toContain("never closed\n````\n\n^s1");
			expect(note).toContain("\\<!-- never closed\n\n^s2");
			expect(note).toContain("%\\% never closed\n\n^s3");
			expect(note).toContain("\\<pre>\n\n^s4");
			expect(note).toMatch(/Plain\.\n\n\^s5\n\n## Dependents\n/);
			expect(yield* problems(out)).toEqual([]);
		}));

	test("leaves code alone: fenced text and inline code are copied as they are", () =>
		Effect.gen(function* () {
			yield* seeded;

			yield* odd({
				s1: "```a`b is not a fence",
				s2: "Obsidian comments use `%%` and `<!--` markers.",
				s3: "```html\n<!-- inside a fence -->\n```",
			});

			const out = yield* projected;

			expect(yield* readText(out, ODD)).toContain(
				"```a`b is not a fence\n\n^s1\n\nObsidian comments use `%%` and `<!--` markers.\n\n^s2\n\n```html\n<!-- inside a fence -->\n```\n\n^s3\n",
			);

			expect(yield* problems(out)).toEqual([]);
		}));

	test("lint reports a source note whose passage swallows the blocks after it", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* seeded;
			yield* odd({ s1: "Fine.", s2: "Also fine." });

			const out = yield* projected;
			const file = path.join(out, ODD);

			expect(yield* problems(out)).toEqual([]);
			yield* fs.chmod(file, 0o644);

			yield* fs.writeFileString(
				file,
				(yield* fs.readFileString(file)).replace("Fine.", "Fine.\n````"),
			);

			expect(yield* problems(out)).toEqual([
				`${ODD}: the Dependents list is hidden by an unclosed fence`,
				`${ODD}: passage ^s1 is not a visible block`,
				`${ODD}: passage ^s2 is not a visible block`,
			]);
		}));

	test("writes claim text, summaries and headings as plain text", () =>
		Effect.gen(function* () {
			yield* seeded;

			const claim = yield* addClaim(
				"shared",
				claimInput("See [[Secret plans]] and [verdict:: contradicted] <!-- hide %% this"),
			);
			yield* researchRun("shared", {
				question: "Is <!-- this hidden?",
				summary: "A summary with [[a link]] and a back\\slash.",
				topics: [{ title: "Odd topic", summary: "Notes on <!-- comments" }],
				claims: [
					{
						key: "a",
						topic: "Odd topic",
						heading: "A [field:: x] heading",
						text: "A guess.",
						verdict: "new",
						sourceType: "GUESS",
						links: [],
					},
				],
				answer: ["a"],
				gaps: [{ ref: "https://example.org/x", reason: "blocked %% by a wall" }],
			});
			const out = yield* projected;
			const topic = yield* readText(out, "shared/Topics/Odd topic.md");

			expect(yield* readText(out, "shared/Topics/Note granularity.md")).toContain(
				String.raw`- See \[\[Secret plans\]\] and \[verdict:\: contradicted\] \<!-- hide %\% this [supports:: [[${SOURCE}#^p1|Dense X Retrieval]]] [basis:: PRIMARY] ^${claim.id}`,
			);

			expect(topic).toContain(String.raw`Notes on \<!-- comments`);
			expect(topic).toContain(String.raw`## A \[field:\: x\] heading`);
			expect(yield* lint(out)).toMatchObject({ problems: [], claimBlocks: 2 });
		}));

	test("keeps comment markers in titles out of file names, links and aliases", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* write("shared", (tx) =>
				Effect.gen(function* () {
					yield* seed(tx);

					yield* tx.putTopic({
						id: "t-evil",
						title: "Evil %% `title`",
						summary: "Odd.",
						headings: [],
					});

					yield* tx.putSource({
						id: "src-cccccccccccccccccccc",
						kind: "capture",
						title: "Page %% title <!-- with `ticks",
						url: "https://example.org/odd",
						sourceType: "PRIMARY",
						captured: "2026-11-01T00:00:00.000Z",
						passages: { p1: "A quote." },
					});

					yield* tx.addClaim({
						...claimInput("Cites the oddly titled page.", "src-cccccccccccccccccccc"),
						topic: "t-evil",
					});
				}),
			);

			const out = yield* projected;

			expect(yield* fs.exists(path.join(out, "shared/Topics/Evil title.md"))).toBe(true);
			expect(yield* lint(out)).toMatchObject({ problems: [], claimBlocks: 1 });
		}));
});
