import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { Vault } from "../src/engine.ts";
import { reindex } from "../src/recall.ts";
import { Cite, remember, researchCheck, researchRun } from "../src/research.ts";
import type { ResearchRunInput } from "../src/research.ts";
import {
	SOURCE,
	claimInput,
	readText,
	seed,
	seeded,
	state,
	tempDir,
	test,
	write,
} from "./tools.ts";

describe("research run", () => {
	test("refuses a shared run that reuses a private claim", () =>
		Effect.gen(function* () {
			yield* seeded;

			const hidden = yield* write("personal", (tx) =>
				tx.putTopic({ id: "t-private", title: "Private", summary: "Private.", headings: [] }).pipe(
					Effect.andThen(
						tx.addClaim({
							text: "A private finding.",
							topic: "t-private",
							heading: "Notes",
							links: [],
							sourceType: "GUESS",
						}),
					),
				),
			);

			expect(
				(yield* Effect.flip(researchRun("shared", input({ reused: [hidden.id] })))).message,
			).toMatch(/refers to c-[a-z0-9]{8}, which is not in the shared tier/);

			expect((yield* state("shared")).runs).toEqual({});
		}));

	const input = (extra: Partial<ResearchRunInput> = {}): ResearchRunInput => ({
		question: "How big should a vault note be?",
		summary: "Topic notes with claim-level IDs.",
		topics: [
			{
				title: "Note granularity",
				summary: "How big a vault note should be.",
				hub: "Agent memory",
			},
		],
		passages: [{ key: "t3", source: SOURCE, text: "Table 3: Recall@5 +12.0." }],
		claims: [
			{
				key: "a",
				topic: "Note granularity",
				heading: "Retrieval unit",
				text: "Proposition indexing beats passage indexing.",
				verdict: "supported",
				sourceType: "PRIMARY",
				links: [{ rel: "supports", to: "t3" }],
			},
		],
		answer: ["a"],
		gaps: [{ ref: "https://example.org/paywalled", reason: "subscription required" }],
		...extra,
	});

	test("counts a source the vault already cited as reused, and refuses a source it never saved", () =>
		Effect.gen(function* () {
			yield* write("shared", (tx) =>
				seed(tx).pipe(Effect.andThen(tx.addClaim(claimInput("Already cites the source.")))),
			);

			const run = yield* researchRun(
				"shared",
				input({
					passages: [{ key: "t3", source: SOURCE, text: "Proposition indexing raises Recall@5." }],
				}),
			);

			expect(run.reused).toEqual([SOURCE]);
			expect(run.created).toEqual(run.answer);

			yield* write("shared", (tx) =>
				tx.putSource({
					id: "doc-0000000000000001",
					kind: "research",
					title: "Earlier lab research",
					sourceType: "DERIVED",
					captured: "2026-10-18T00:00:00.000Z",
					passages: { s1: "An earlier finding." },
				}),
			);

			const fromLab = yield* researchRun(
				"shared",
				input({
					passages: [{ key: "t3", source: "doc-0000000000000001", text: "An earlier finding." }],
				}),
			);

			expect(fromLab.reused).toEqual(["doc-0000000000000001"]);
			expect(fromLab.created).toEqual(fromLab.answer);

			expect(
				(yield* Effect.flip(
					researchRun(
						"shared",
						input({ passages: [{ key: "t3", source: "src-ffffffffffffffffffff", text: "x" }] }),
					),
				)).message,
			).toMatch(/capture the source/);
		}));

	test("checks the vault first and names the sources worth re-checking", () =>
		Effect.gen(function* () {
			yield* write("shared", (tx) =>
				seed(tx).pipe(Effect.andThen(tx.addClaim(claimInput("Propositions beat passages.")))),
			);

			yield* reindex;
			expect((yield* researchCheck("do propositions beat passages")).recheck).toEqual([]);

			yield* TestClock.setTime(Date.parse("2028-01-01T00:00:00.000Z"));
			yield* reindex;

			const check = yield* researchCheck("do propositions beat passages");

			expect(check.claims).toHaveLength(1);

			expect(check.recheck).toEqual([
				{
					id: SOURCE,
					title: "Dense X Retrieval",
					freshness: "stale",
					url: `https://example.org/${SOURCE}`,
				},
			]);
		}));

	test("keeps topics apart when their titles slug the same, and keeps a topic's shelf life", () =>
		Effect.gen(function* () {
			const titles = ["C++", "C#", "日本語の研究"];
			const run = yield* researchRun("shared", {
				question: "Which language?",
				summary: "Three topics.",
				topics: titles.map((title) => ({ title, summary: `About ${title}.`, shelfLifeDays: 30 })),
				claims: titles.map((topic) => ({
					key: topic,
					topic,
					heading: "Notes",
					text: `A guess about ${topic}.`,
					verdict: "new" as const,
					sourceType: "GUESS" as const,
					links: [],
				})),
				answer: ["C++"],
			});
			const { topics, claims } = yield* state("shared");

			expect(run.topics.map((id) => topics[id]?.title)).toEqual(titles);
			expect(run.created.map((id) => topics[claims[id]?.topic ?? ""]?.title)).toEqual(titles);

			const again = yield* remember("shared", { text: "Again.", topic: "C#" });

			expect(again.topic).toBe(run.topics[1]);
			expect((yield* state("shared")).topics[again.topic]?.shelfLifeDays).toBe(30);
		}));
});

describe("remember", () => {
	test("cites an imported document by ID without asking vault-cite to capture it", () =>
		Effect.gen(function* () {
			const id = "doc-abcdef1234567890";

			yield* write("shared", (tx) =>
				tx.putSource({
					id,
					kind: "memory",
					origin: "notes/kiln.md",
					title: "Kiln",
					sourceType: "DERIVED",
					captured: "2026-11-19T00:00:00.000Z",
					passages: { s1: "Glaze firing starts at noon." },
				}),
			);

			const claim = yield* remember("personal", {
				text: "Glaze firing starts at noon.",
				topic: "Firing",
				source: id,
			});

			expect(claim.links).toEqual([{ rel: "source", target: id }]);
			expect(claim.sourceType).toBe("DERIVED");
		}));

	test("records who said it as a DIRECT source and never fetches for a known source", () =>
		Effect.gen(function* () {
			yield* seeded;

			const said = yield* remember("shared", {
				text: "The owner locked option A.",
				topic: "Note granularity",
				direct: { title: "Owner in chat 2026-11-17", quote: "A and test on first real tests" },
			});
			const cited = yield* remember("shared", {
				text: "Recall rises.",
				topic: "Note granularity",
				source: SOURCE,
				quote: "Recall@5 +12.0",
			});

			expect(said.sourceType).toBe("DIRECT");

			expect((yield* (yield* Vault).view).source(said.links[0]?.target ?? "")).toMatchObject({
				kind: "direct",
				sourceType: "DIRECT",
			});

			expect(cited.links).toEqual([
				{
					rel: "source",
					target: SOURCE,
					passage: `p-${createHash("sha256").update("Recall@5 +12.0").digest("hex").slice(0, 10)}`,
				},
			]);

			expect(
				(yield* Effect.flip(
					remember("shared", {
						text: "x",
						topic: "Note granularity",
						source: "https://example.org/new",
					}),
				)).message,
			).toMatch(/No vault-cite command/);
		}));

	test("gives the same speaker in two tiers, or two short or non-Latin names, distinct sources", () =>
		Effect.gen(function* () {
			yield* seeded;

			const target = (claim: { links: readonly { target: string }[] }) => claim.links[0]?.target;
			const shared = yield* remember("shared", {
				text: "Said in shared.",
				topic: "Note granularity",
				direct: { title: "Eli", quote: "one" },
			});
			const personal = yield* remember("personal", {
				text: "Said in personal.",
				topic: "Private",
				direct: { title: "Eli", quote: "two" },
			});
			const other = yield* remember("shared", {
				text: "Another.",
				topic: "Note granularity",
				direct: { title: "田中", quote: "はい" },
			});

			expect(new Set([target(shared), target(personal), target(other)]).size).toBe(3);
			expect((yield* (yield* Vault).view).source(target(shared) ?? "")?.title).toBe("Eli");
		}));

	test("refuses a quote that names no source", () =>
		Effect.gen(function* () {
			yield* seeded;

			expect(
				(yield* Effect.flip(
					remember("shared", {
						text: "Claim.",
						topic: "Note granularity",
						quote: "floating quote",
					}),
				)).message,
			).toMatch(/quote needs the source/);

			expect((yield* state("shared")).claims).toEqual({});
		}));
});

describe("capture", () => {
	test(
		"captures an unsaved reference through vault-cite once, then reuses it",
		() =>
			Effect.gen(function* () {
				const log = path.join(yield* tempDir, "calls.log");
				const cite = Cite.layer([
					process.execPath,
					"--no-warnings",
					path.join(import.meta.dirname, "fake-cite.ts"),
					log,
				]);

				yield* Effect.gen(function* () {
					yield* seeded;

					const first = yield* remember("shared", {
						text: "Fetched once.",
						topic: "Note granularity",
						source: "https://example.org/page",
					});
					const second = yield* remember("shared", {
						text: "Reused.",
						topic: "Note granularity",
						source: "https://example.org/page",
					});
					const blocked = yield* Effect.flip(
						remember("shared", {
							text: "Blocked.",
							topic: "Note granularity",
							source: "https://elsewhere.test/x",
						}),
					);

					expect(first.links).toEqual([{ rel: "source", target: "src-feedfacefeedfacefeed" }]);
					expect(second.links).toEqual(first.links);

					expect((yield* state("shared")).sources["src-feedfacefeedfacefeed"]).toMatchObject({
						kind: "capture",
						title: "A fetched page",
						captured: "2026-11-16T08:00:00.000Z",
					});

					expect(blocked.message).toBe(
						"vault-cite did not save https://elsewhere.test/x: robots.txt disallows it",
					);

					expect(yield* readText(log)).toBe(
						"add https://example.org/page\nadd https://elsewhere.test/x\n",
					);
				}).pipe(Effect.provide(cite));
			}),
		30_000,
	);
});
