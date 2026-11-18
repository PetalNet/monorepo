import path from "node:path";

import { describe, expect } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { Vault } from "../src/engine.ts";
import { project } from "../src/project.ts";
import {
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
describe("projection", () => {
	test("writes each claim as one list item with typed wikilinks and a trailing block ID", () =>
		Effect.gen(function* () {
			const claim = yield* write("shared", (tx) =>
				seed(tx).pipe(
					Effect.andThen(tx.addClaim(claimInput("Claims retrieve better than passages."))),
				),
			);
			const out = yield* projected;

			expect(yield* readText(out, "shared/Topics/Note granularity.md")).toContain(
				`## Retrieval unit\n- Claims retrieve better than passages. [supports:: [[${SOURCE}#^p1|Dense X Retrieval]]] [basis:: PRIMARY] ^${claim.id}\n`,
			);
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

			yield* project(out).pipe(Effect.provideService(Vault, other));

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
		}));
});

describe("projected text", () => {
	test("writes claim text as plain text", () =>
		Effect.gen(function* () {
			yield* seeded;

			const claim = yield* addClaim(
				"shared",
				claimInput("See [[Secret plans]] and [verdict:: contradicted] <!-- hide %% this"),
			);
			const out = yield* projected;

			expect(yield* readText(out, "shared/Topics/Note granularity.md")).toContain(
				String.raw`- See \[\[Secret plans\]\] and \[verdict:\: contradicted\] \<!-- hide %\% this [supports:: [[${SOURCE}#^p1|Dense X Retrieval]]] [basis:: PRIMARY] ^${claim.id}`,
			);
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
		}));
});
