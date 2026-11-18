import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { LoroDoc } from "loro-crdt";

import { Vault } from "../src/engine.ts";
import { SecretFound, WriteRejected } from "../src/errors.ts";
import {
	NOON,
	OTHER,
	SOURCE,
	TOPIC,
	addClaim,
	claimInput,
	exists,
	seed,
	remove,
	seeded,
	state,
	stored,
	test,
	testEach,
	vaultAt,
	write,
} from "./tools.ts";

const token = `ghp_${"a1B2".repeat(9)}`;

describe("documents", () => {
	test("stores claims and sources as plain values keyed by their ID, one document per tier", () =>
		Effect.gen(function* () {
			const vault = yield* Vault;
			const claim = yield* write("shared", (tx) =>
				seed(tx).pipe(
					Effect.andThen(tx.addClaim(claimInput("Claims retrieve better than passages."))),
				),
			);
			const doc = LoroDoc.fromSnapshot(yield* vault.snapshot("shared"));

			// A plain value comes back as a JS object; a nested Loro container would come back as a container.
			expect(doc.getMap("claims").get(claim.id)).toMatchObject({ id: claim.id, text: claim.text });
			expect(doc.getMap("sources").get(SOURCE)).toMatchObject({ id: SOURCE });
			expect(yield* exists(vault.file("shared"))).toBe(true);
			expect(yield* exists(vault.file("personal"))).toBe(false);
		}));

	test("records each agent as its own peer, with time and message, and can travel back", () =>
		Effect.gen(function* () {
			const vault = yield* Vault;

			yield* seeded;
			yield* TestClock.setTime(Date.parse("2026-11-18T12:00:00.000Z"));

			const scout = yield* vaultAt(vault.root, "scout");
			const claim = yield* addClaim("shared", claimInput("Small units need context.")).pipe(
				Effect.provideService(Vault, scout),
			);
			const history = yield* vault.history("shared");

			expect(history.map((change) => [change.agent, change.message])).toEqual([
				["janet@test-host", "seed"],
				["scout@test-host", `add claim in ${TOPIC}`],
			]);

			expect(new Set(history.map((change) => change.peer)).size).toBe(2);
			expect(history[1]?.timestamp).toBe(Date.parse("2026-11-18T12:00:00.000Z") / 1000);
			expect((yield* vault.at("shared", new Date("2026-11-17T23:00:00.000Z"))).claims).toEqual({});

			expect(
				(yield* vault.at("shared", new Date("2026-11-18T12:00:00.000Z"))).claims[claim.id]?.agent,
			).toBe("scout");
		}));

	test("travels to a consistent version when a host's clock runs behind", () =>
		Effect.gen(function* () {
			const vault = yield* Vault;

			yield* seeded;
			yield* TestClock.setTime(Date.parse("2026-11-17T11:30:00.000Z"));

			const slow = yield* vaultAt(vault.root, "slow");
			const claim = yield* addClaim(
				"shared",
				claimInput("Written by a host whose clock is slow."),
			).pipe(Effect.provideService(Vault, slow));

			// The claim builds on the 12:00 seed, so it cannot appear in a version from before the seed.
			expect(yield* vault.at("shared", new Date("2026-11-17T11:45:00.000Z"))).toEqual({
				claims: {},
				sources: {},
				topics: {},
				runs: {},
			});

			const noon = yield* vault.at("shared", new Date(NOON));

			expect(noon.claims[claim.id]?.text).toBe("Written by a host whose clock is slow.");
			expect(noon.sources[SOURCE]?.title).toBe("Dense X Retrieval");
		}));

	test("records each write as its own change", () =>
		Effect.gen(function* () {
			yield* seeded;
			yield* addClaim("shared", claimInput("First."));
			yield* addClaim("shared", claimInput("Second."));

			expect((yield* (yield* Vault).history("shared")).map((change) => change.message)).toEqual([
				"seed",
				`add claim in ${TOPIC}`,
				`add claim in ${TOPIC}`,
			]);
		}));
});

describe("write checks", () => {
	test("rejects a write that carries a secret anywhere, commit message included, and keeps nothing of it", () =>
		Effect.gen(function* () {
			yield* seeded;

			for (const attempt of [
				addClaim("shared", claimInput(`The deploy token is ${token}`)),
				write(
					"shared",
					(tx) => tx.putTopic({ id: "t-fine", title: "Fine", summary: "Fine.", headings: [] }),
					`note ${token}`,
				),
				write("shared", (tx) =>
					tx.putTopic({ id: "t-raw", title: "Clean", summary: `see ${token}`, headings: [] }),
				),
			]) {
				expect(yield* Effect.flip(attempt)).toBeInstanceOf(SecretFound);
			}

			expect(Object.keys((yield* state("shared")).claims)).toEqual([]);
			expect(Object.keys((yield* state("shared")).topics)).toEqual([TOPIC]);
			expect(yield* stored("shared")).not.toContain(token);
			expect(yield* stored("shared")).toContain("Dense X Retrieval");
		}));

	testEach([
		["after a newline", `setup:\n${token}`],
		["after a tab", `key\t${["AKIA", "IOSFODNN7", "EXAMPLE"].join("")}`],
		["in a quoted assignment", `password="${["Zq8vR2mW", "9xKp4Lt7"].join("")}"`],
	])("rejects a secret %s inside a passage", (_, text) =>
		Effect.gen(function* () {
			yield* seeded;

			const error = yield* Effect.flip(write("shared", (tx) => tx.addPassage(SOURCE, text)));

			expect(error).toBeInstanceOf(SecretFound);
			expect(Object.keys((yield* state("shared")).sources[SOURCE]?.passages ?? {})).toEqual(["p1"]);
		}),
	);

	test("requires a source for anything that is not a guess", () =>
		Effect.gen(function* () {
			yield* seeded;

			expect(
				(yield* Effect.flip(addClaim("shared", { ...claimInput("Unsourced."), links: [] })))
					.message,
			).toMatch(/needs a source/);

			expect(
				yield* Effect.flip(
					addClaim("shared", {
						...claimInput("Cites nothing real."),
						links: [{ rel: "supports", target: "src-ffffffffffffffffffff" }],
					}),
				),
			).toBeInstanceOf(WriteRejected);

			expect(
				(yield* addClaim("shared", { ...claimInput("A hunch."), links: [], sourceType: "GUESS" }))
					.sourceType,
			).toBe("GUESS");
		}));

	test("checks every record against its schema", () =>
		Effect.gen(function* () {
			yield* seeded;

			for (const attempt of [
				write("shared", (tx) =>
					tx.putTopic({ id: "t-bad", title: "Two\nlines", summary: "x", headings: [] }),
				),
				write("shared", (tx) =>
					tx.putTopic({ id: "Not an ID", title: "Ok", summary: "x", headings: [] }),
				),
				addClaim("shared", { ...claimInput("Claim\n## Dependents") }),
			]) {
				expect(yield* Effect.flip(attempt)).toBeInstanceOf(WriteRejected);
			}

			expect(Object.keys((yield* state("shared")).topics)).toEqual([TOPIC]);
			expect((yield* state("shared")).claims).toEqual({});
		}));

	test("leaves nothing of a refused source behind when the write carries on", () =>
		Effect.gen(function* () {
			yield* write("shared", (tx) =>
				tx
					.putSource({
						id: "doc-0000000000000002",
						kind: "research",
						title: "Half valid",
						sourceType: "DERIVED",
						captured: "2026-10-18T00:00:00.000Z",
						passages: { s1: "Fine.", "Not an ID": "Refused." },
					})
					.pipe(
						Effect.flip,
						Effect.andThen(
							tx.putTopic({
								id: "t-after",
								title: "After",
								summary: "Written after.",
								headings: [],
							}),
						),
					),
			);

			expect(Object.keys((yield* state("shared")).sources)).toEqual([]);
			expect(Object.keys((yield* state("shared")).topics)).toEqual(["t-after"]);
			expect(yield* stored("shared")).not.toContain("Half valid");
		}));

	test("keeps the old claim when one is replaced, and never revives a retired one", () =>
		Effect.gen(function* () {
			const old = yield* write("shared", (tx) =>
				seed(tx).pipe(Effect.andThen(tx.addClaim(claimInput("Per-claim files are needed.")))),
			);
			const next = yield* write("shared", (tx) =>
				tx.replaceClaim(old.id, claimInput("Claim-level indexing is enough.")),
			);
			const { claims } = yield* state("shared");

			expect(claims[old.id]).toMatchObject({
				status: "superseded",
				supersededBy: next.id,
				text: old.text,
			});

			expect(next.links).toContainEqual({ rel: "replaces", target: old.id });

			yield* write("shared", (tx) => tx.retractClaim(next.id, "wrong"));

			expect((yield* state("shared")).claims[next.id]).toMatchObject({
				status: "retracted",
				reason: "wrong",
			});
		}));

	test("never changes a passage once it is written", () =>
		Effect.gen(function* () {
			yield* seeded;

			const error = yield* Effect.flip(
				write("shared", (tx) =>
					tx.putSource({
						id: SOURCE,
						kind: "capture",
						title: "Dense X Retrieval",
						url: `https://example.org/${SOURCE}`,
						sourceType: "PRIMARY",
						captured: "2026-11-01T00:00:00.000Z",
						passages: { p1: "Different text." },
					}),
				),
			);

			expect(error.message).toMatch(/already holds different text/);

			expect((yield* state("shared")).sources[SOURCE]?.passages).toEqual({
				p1: "Proposition indexing raises Recall@5.",
			});
		}));
});

describe("staleness", () => {
	test("flags every claim that cites a replaced source, in every tier, and leaves the rest alone", () =>
		Effect.gen(function* () {
			const [cites, unrelated] = yield* write("shared", (tx) =>
				Effect.gen(function* () {
					yield* seed(tx);
					yield* seed(tx, OTHER);

					return [
						yield* tx.addClaim(claimInput("Cites the old source.")),
						yield* tx.addClaim(claimInput("Cites another.", OTHER)),
					];
				}),
			);
			const personal = yield* write("personal", (tx) =>
				tx
					.putTopic({ id: TOPIC, title: "Private notes", summary: "Private.", headings: [] })
					.pipe(Effect.andThen(tx.addClaim(claimInput("A private claim on the same source.")))),
			);
			const flagged = yield* (yield* Vault).retireSource(SOURCE, {
				status: "replaced",
				replacedBy: OTHER,
				reason: "v2 published",
			});

			expect(new Set(flagged)).toEqual(new Set([cites?.id, personal.id]));
			expect((yield* state("shared")).claims[cites?.id ?? ""]?.stale?.sources).toEqual([SOURCE]);
			expect((yield* state("personal")).claims[personal.id]?.stale?.sources).toEqual([SOURCE]);
			expect((yield* state("shared")).claims[unrelated?.id ?? ""]?.stale).toBeUndefined();

			expect((yield* state("shared")).sources[SOURCE]).toMatchObject({
				status: "replaced",
				replacedBy: OTHER,
			});
		}));

	test("flags on retraction too, and flags a claim written after the retraction", () =>
		Effect.gen(function* () {
			const claim = yield* write("shared", (tx) =>
				Effect.gen(function* () {
					yield* seed(tx);
					yield* seed(tx, OTHER);

					return yield* tx.addClaim(claimInput("Cites the retracted source."));
				}),
			);

			expect(
				yield* (yield* Vault).retireSource(SOURCE, {
					status: "retracted",
					reason: "paper withdrawn",
				}),
			).toEqual([claim.id]);

			expect(
				(yield* addClaim("shared", claimInput("Written after the retraction."))).stale?.sources,
			).toEqual([SOURCE]);

			expect(
				(yield* addClaim("shared", claimInput("On a live source.", OTHER))).stale,
			).toBeUndefined();
		}));
});

describe("tiers and locks", () => {
	test("refuses a shared claim that links into a private tier", () =>
		Effect.gen(function* () {
			const privateSource = "src-bbbbbbbbbbbbbbbbbbbb";

			yield* seeded;
			yield* write("personal", (tx) => seed(tx, privateSource));

			expect(
				(yield* Effect.flip(
					addClaim("shared", claimInput("Leaks a private source.", privateSource)),
				)).message,
			).toMatch(/cannot link to .* in the personal tier/);

			expect(
				(yield* addClaim("personal", claimInput("Private claim on a shared source."))).status,
			).toBe("active");
		}));

	test("keeps a source ID to one tier", () =>
		Effect.gen(function* () {
			yield* seeded;

			expect((yield* Effect.flip(write("personal", (tx) => seed(tx)))).message).toMatch(
				/in the shared tier already/,
			);

			expect((yield* state("personal")).sources).toEqual({});
		}));

	test(
		"loses no write when three processes write the same tier at once",
		() =>
			Effect.gen(function* () {
				const vault = yield* Vault;
				const writer = path.join(import.meta.dirname, "writer.ts");
				const run = (agent: string) =>
					Effect.promise(
						() =>
							new Promise<number | null>((resolve) => {
								spawn(process.execPath, ["--no-warnings", writer, vault.root, agent, "12"], {
									stdio: "ignore",
								}).on("exit", resolve);
							}),
					);

				yield* seeded;

				expect(
					yield* Effect.all([run("one"), run("two"), run("three")], { concurrency: "unbounded" }),
				).toEqual([0, 0, 0]);

				expect(Object.keys((yield* state("shared")).claims)).toHaveLength(36);
			}),
		60_000,
	);

	test("saves nothing if the tier changed underneath a write that lost its lock", () =>
		Effect.gen(function* () {
			const vault = yield* Vault;
			const other = yield* vaultAt(vault.root, "other");

			yield* seeded;

			const error = yield* Effect.flip(
				write("shared", (tx) =>
					Effect.gen(function* () {
						yield* tx.addClaim(claimInput("From the writer that lost its lock."));
						yield* remove(`${vault.file("shared")}.lock`);

						yield* addClaim("shared", claimInput("From the writer that took over.")).pipe(
							Effect.provideService(Vault, other),
						);
					}),
				),
			);

			expect(error.message).toMatch(/changed during this write/);

			expect(Object.values((yield* state("shared")).claims).map((claim) => claim.text)).toEqual([
				"From the writer that took over.",
			]);
		}));
});
