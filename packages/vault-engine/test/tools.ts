import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { TestClock } from "effect/testing";

import { Vault } from "../src/engine.ts";
import type { NewClaim, Tx } from "../src/engine.ts";
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

export const TOPIC = "t-note-granularity";

/** A topic, the minimum a claim needs. */
export const seed = (tx: Tx) =>
	tx.putTopic({
		id: TOPIC,
		title: "Note granularity",
		summary: "How big a vault note should be.",
		headings: ["Retrieval unit"],
	});

export const seeded = write("shared", seed, "seed");

export const claimInput = (text: string) => ({
	text,
	topic: TOPIC,
	heading: "Retrieval unit",
	sourceType: "PRIMARY" as const,
});

/** Adds one claim in its own write, the way `remember` does. */
export const addClaim = (tier: Tier, input: NewClaim) =>
	write(tier, (tx) => tx.addClaim(input), `add claim in ${input.topic}`);
