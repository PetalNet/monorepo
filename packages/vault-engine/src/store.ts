import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Context, Duration, Effect, FileSystem, Layer, Predicate } from "effect";
import type { Option, Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { WriteRejected } from "./errors.ts";
import type { Tier } from "./schema.ts";

const isSystemError = (tag: PlatformError["reason"]["_tag"]) => (error: PlatformError) =>
	Predicate.isTagged(error.reason, tag);

/** A file that does not exist reads as `None`; every other failure stays a failure. */
const ifExists = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
	effect.pipe(
		Effect.asSome,
		Effect.catchIf(isSystemError("NotFound"), () => Effect.succeedNone),
	);

export interface TierFilesShape {
	readonly file: (tier: Tier) => string;
	readonly read: (tier: Tier) => Effect.Effect<Option.Option<Uint8Array>, PlatformError>;
	/**
	 * Replaces the tier file with `bytes` so that a crash leaves either the old file or the whole new
	 * one.
	 */
	readonly save: (tier: Tier, bytes: Uint8Array) => Effect.Effect<void, PlatformError>;
	/**
	 * Holds the tier's lock for the scope: a hard link to a file naming the holder, which fails if
	 * the lock exists. Only the holder releases it.
	 */
	readonly lock: (tier: Tier) => Effect.Effect<void, WriteRejected | PlatformError, Scope.Scope>;
}

/** The tier files of one vault folder: `<root>/docs/<tier>.loro`. */
export class TierFiles extends Context.Service<TierFiles, TierFilesShape>()(
	"vault-engine/TierFiles",
) {
	static readonly make = (root: string, host = os.hostname()) => makeTierFiles(root, host);
	static readonly layer = (root: string, host = os.hostname()) =>
		Layer.effect(TierFiles, makeTierFiles(root, host));
}

const reject = (message: string) => new WriteRejected({ message });

const makeTierFiles = Effect.fnUntraced(function* (root: string, host: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = (tier: Tier) => path.join(root, "docs", `${tier}.loro`);
	const read = (tier: Tier) => ifExists(fs.readFile(file(tier)));

	yield* fs.makeDirectory(path.join(root, "docs"), { recursive: true, mode: 0o700 });

	const save = Effect.fnUntraced(function* (tier: Tier, bytes: Uint8Array) {
		const target = file(tier);
		const temporary = `${target}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;

		yield* Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });

					yield* handle.writeAll(bytes);
					yield* handle.sync;
				}),
			);

			yield* fs.rename(temporary, target);
		}).pipe(Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
	});

	const lock = (tier: Tier) => {
		const lockFile = `${file(tier)}.lock`;
		const token = `${host}:${String(process.pid)}:${randomBytes(8).toString("hex")}`;
		const mine = `${lockFile}.${randomBytes(8).toString("hex")}`;

		const take: Effect.Effect<void, PlatformError> = Effect.gen(function* () {
			yield* fs.writeFileString(mine, token);
			yield* fs.link(mine, lockFile);
		}).pipe(
			Effect.catchIf(isSystemError("AlreadyExists"), () =>
				Effect.sleep(Duration.millis(25)).pipe(Effect.andThen(take)),
			),
		);

		const release = Effect.gen(function* () {
			const holder = yield* fs.readFileString(lockFile).pipe(Effect.orElseSucceed(() => ""));

			if (holder === token) {
				yield* fs.remove(lockFile, { force: true });
			}
		}).pipe(Effect.ensuring(fs.remove(mine, { force: true }).pipe(Effect.ignore)), Effect.ignore);

		return Effect.acquireRelease(
			take.pipe(
				Effect.timeoutOrElse({
					duration: Duration.minutes(2),
					orElse: () => Effect.fail(reject(`Timed out waiting for the ${tier} tier lock`)),
				}),
				Effect.onError(() => fs.remove(mine, { force: true }).pipe(Effect.ignore)),
			),
			() => release,
		);
	};

	return { file, read, save, lock } satisfies TierFilesShape;
});
