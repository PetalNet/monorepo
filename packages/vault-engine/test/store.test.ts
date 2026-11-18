import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Option } from "effect";

import { TierFiles, stampOf } from "../src/store.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const files = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	return { fs, store: yield* TierFiles.make(yield* fs.makeTempDirectory(), "test-host") };
});

describe("tier files", () => {
	it.effect("saves a whole new version, keeps the one it replaced, and refuses a stale base", () =>
		Effect.gen(function* () {
			const { fs, store } = yield* files;

			yield* store.save("shared", "new", bytes("one"));
			yield* store.save("shared", stampOf(Option.some(bytes("one"))), bytes("two"));

			expect(yield* fs.readFileString(store.file("shared"))).toBe("two");
			expect(yield* fs.readFileString(`${store.file("shared")}.prev`)).toBe("one");

			const refused = yield* Effect.flip(
				store.save("shared", stampOf(Option.some(bytes("one"))), bytes("three")),
			);

			expect(refused.message).toMatch(/changed during this write/);
			expect(yield* fs.readFileString(store.file("shared"))).toBe("two");
			expect(Option.isNone(yield* store.read("personal"))).toBe(true);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live("makes a second writer wait for the lock, and clears a lock left by a dead process", () =>
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

			yield* fs.writeFileString(lockFile, "test-host:2147483646:stale");
			yield* Effect.scoped(store.lock("shared"));
			expect(yield* fs.exists(lockFile)).toBe(false);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
