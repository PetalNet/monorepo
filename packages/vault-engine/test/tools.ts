import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { LoroDoc } from "loro-crdt";

import { Vault } from "../src/engine.ts";
import type { NewClaim, Tx, VaultShape } from "../src/engine.ts";
import type { Tier } from "../src/schema.ts";
import { TierFiles } from "../src/store.ts";

const files = <A>(use: (fs: FileSystem.FileSystem) => Effect.Effect<A, PlatformError>) =>
	Effect.flatMap(FileSystem.FileSystem, use).pipe(Effect.orDie);

export const tempDir = files((fs) => fs.makeTempDirectory({ prefix: "vault-engine-" }));
export const readText = (...parts: string[]) =>
	files((fs) => fs.readFileString(path.join(...parts)));
export const writeText = (file: string, text: string) =>
	files((fs) => fs.writeFileString(file, text));
export const exists = (...parts: string[]) => files((fs) => fs.exists(path.join(...parts)));
export const remove = (file: string) => files((fs) => fs.remove(file));

export const NOON = Date.parse("2026-11-17T12:00:00.000Z");

/** A vault in a fresh folder, writing as `agent` on `test-host`. */
export const vaultAt = (root?: string, agent = "janet") =>
	Effect.gen(function* () {
		const dir = root ?? (yield* tempDir);

		return yield* Vault.make({ root: dir, agent, host: "test-host" }).pipe(
			Effect.provide(TierFiles.layer(dir, "test-host")),
		);
	});

/** A test with a fresh vault provided as the `Vault` service and the clock at noon on 2026-11-17. */
export const test = (
	name: string,
	body: () => Effect.Effect<void, unknown, Vault | NodeServices.NodeServices>,
	timeout?: number,
) => {
	it.effect(
		name,
		() =>
			TestClock.setTime(NOON).pipe(
				Effect.andThen(body),
				Effect.provide(
					Layer.effect(
						Vault,
						Effect.suspend(() => vaultAt()),
					).pipe(Layer.provideMerge(NodeServices.layer)),
				),
			),
		timeout,
	);
};

/** Runs one write on the provided vault. */
export const write = <A, E>(tier: Tier, body: (tx: Tx) => Effect.Effect<A, E>, message = "test") =>
	Effect.flatMap(Vault, (vault) => vault.transact(tier, message, body));

export const state = (tier: Tier) =>
	Effect.flatMap(Vault, (vault) => Effect.map(vault.view, (view) => view.tiers[tier]));

/**
 * Everything a tier's document holds, history included, as searchable text. A snapshot is
 * compressed, so searching its bytes proves nothing.
 */
export const stored = (tier: Tier, vault?: VaultShape) =>
	Effect.map(
		vault === undefined
			? Effect.flatMap(Vault, (provided) => provided.snapshot(tier))
			: vault.snapshot(tier),
		(bytes) => JSON.stringify(LoroDoc.fromSnapshot(bytes).exportJsonUpdates()),
	);

export const SOURCE = "src-0123456789abcdef0123";
export const OTHER = "src-aaaaaaaaaaaaaaaaaaaa";
export const TOPIC = "t-note-granularity";

/** A topic and a captured source with one passage, the minimum a sourced claim needs. */
export const seed = (tx: Tx, source = SOURCE) =>
	Effect.gen(function* () {
		yield* tx.putTopic({
			id: TOPIC,
			title: "Note granularity",
			summary: "How big a vault note should be.",
			headings: ["Retrieval unit"],
		});

		yield* tx.putSource({
			id: source,
			kind: "capture",
			title: "Dense X Retrieval",
			url: `https://example.org/${source}`,
			sourceType: "PRIMARY",
			captured: "2026-11-01T00:00:00.000Z",
			passages: { p1: "Proposition indexing raises Recall@5." },
		});
	});

export const seeded = write("shared", seed, "seed");

export const claimInput = (text: string, source = SOURCE) => ({
	text,
	topic: TOPIC,
	heading: "Retrieval unit",
	links: [{ rel: "supports" as const, target: source, passage: "p1" }],
	sourceType: "PRIMARY" as const,
});

/** Adds one claim in its own write, the way `remember` does. */
export const addClaim = (tier: Tier, input: NewClaim) =>
	write(tier, (tx) => tx.addClaim(input), `add claim in ${input.topic}`);
