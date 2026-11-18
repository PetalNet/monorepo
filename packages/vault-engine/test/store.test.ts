import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Option } from "effect";

import { TierFiles } from "../src/store.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const files = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	return { fs, store: yield* TierFiles.make(yield* fs.makeTempDirectory(), "test-host") };
});

describe("tier files", () => {
	it.effect("saves a whole new version", () =>
		Effect.gen(function* () {
			const { fs, store } = yield* files;

			yield* store.save("shared", bytes("one"));
			yield* store.save("shared", bytes("two"));

			expect(yield* fs.readFileString(store.file("shared"))).toBe("two");
			expect(Option.isNone(yield* store.read("personal"))).toBe(true);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live("makes a second writer wait for the lock", () =>
		Effect.gen(function* () {
			const { fs, store } = yield* files;
			const lockFile = `${store.file("shared")}.lock`;
			const order: string[] = [];
			const held = yield* Deferred.make<true>();
			const first = yield* Effect.scoped(
				Effect.gen(function* () {
					yield* store.lock("shared");
					yield* Deferred.succeed(held, true);
					yield* Effect.sleep("100 millis");
					order.push("first");
				}),
			).pipe(Effect.forkChild);

			yield* Deferred.await(held);

			yield* Effect.scoped(
				store.lock("shared").pipe(Effect.andThen(Effect.sync(() => order.push("second")))),
			);

			yield* Fiber.join(first);

			expect(order).toEqual(["first", "second"]);
			expect(yield* fs.exists(lockFile)).toBe(false);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
