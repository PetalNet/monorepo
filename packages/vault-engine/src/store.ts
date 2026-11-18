import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Context, Duration, Effect, FileSystem, Layer, Option, Predicate } from "effect";
import type { Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { WriteRejected } from "./errors.ts";
import type { Tier } from "./schema.ts";

const isSystemError = (tag: PlatformError["reason"]["_tag"]) => (error: PlatformError) =>
	Predicate.isTagged(error.reason, tag);

/** A file that does not exist reads as `None`; every other failure stays a failure. */
export const ifExists = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
	effect.pipe(
		Effect.asSome,
		Effect.catchIf(isSystemError("NotFound"), () => Effect.succeedNone),
	);

/** Identifies one saved version of a tier: a hash of its bytes, or "new" when it has no file. */
export const stampOf = (bytes: Option.Option<Uint8Array>) =>
	Option.match(bytes, {
		onNone: () => "new",
		onSome: (found) => createHash("sha256").update(found).digest("hex"),
	});

/** Whether a process on this host still runs. */
function alive(pid: number) {
	try {
		process.kill(pid, 0);

		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

export interface TierFilesShape {
	readonly file: (tier: Tier) => string;
	readonly read: (tier: Tier) => Effect.Effect<Option.Option<Uint8Array>, PlatformError>;
	/**
	 * Replaces the tier file with `bytes` so that a crash leaves either the old file or the whole new
	 * one, and only if the file is still the version `stamp` names. The replaced version stays beside
	 * it as `<tier>.loro.prev`.
	 */
	readonly save: (
		tier: Tier,
		stamp: string,
		bytes: Uint8Array,
	) => Effect.Effect<void, WriteRejected | PlatformError>;
	/**
	 * Holds the vault's write lock for the scope: one lock for every tier, because a write checks the
	 * other tiers too. It is a hard link to a file naming the holder, which fails if the lock exists.
	 * Only the holder releases it. A lock whose holder is a dead process on this host, or that is
	 * older than an hour, is cleared.
	 */
	readonly lock: Effect.Effect<void, WriteRejected | PlatformError, Scope.Scope>;
	readonly lockFile: string;
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

	const save = Effect.fnUntraced(function* (tier: Tier, stamp: string, bytes: Uint8Array) {
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

			// The lock should make this impossible; if the file moved on anyway, losing this write
			// loudly beats overwriting someone else's silently.
			if (stampOf(yield* read(tier)) !== stamp) {
				return yield* reject(
					`The ${tier} tier changed during this write; nothing was saved, retry`,
				);
			}

			if (stamp !== "new") {
				yield* fs.remove(`${target}.prev`, { force: true });
				yield* fs.link(target, `${target}.prev`);
			}

			yield* fs.rename(temporary, target);
		}).pipe(Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
	});

	const lockFile = path.join(root, "docs", "vault.lock");
	const lock = Effect.suspend(() => {
		const token = `${host}:${String(process.pid)}:${randomBytes(8).toString("hex")}`;
		const mine = `${lockFile}.${randomBytes(8).toString("hex")}`;

		const clearDead = Effect.gen(function* () {
			const holder = yield* fs.readFileString(lockFile);
			const info = yield* fs.stat(lockFile);
			const [holderHost, pid] = holder.split(":");
			const age =
				Date.now() - Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() });

			if (age <= 3_600_000 && (holderHost !== host || alive(Number(pid)))) {
				return false;
			}

			// Rename, then look at what was renamed: if another waiter cleared the dead lock first and
			// a live writer has since taken it, this set a live lock aside and must hand it back.
			const aside = `${lockFile}.dead.${randomBytes(4).toString("hex")}`;

			yield* fs.rename(lockFile, aside);

			if ((yield* fs.readFileString(aside)) !== holder) {
				yield* fs.link(aside, lockFile).pipe(Effect.ignore);
			}

			yield* fs.remove(aside, { force: true });

			return true;
		}).pipe(Effect.orElseSucceed(() => false));

		const take: Effect.Effect<void, PlatformError> = Effect.gen(function* () {
			yield* fs.writeFileString(mine, token);
			yield* fs.link(mine, lockFile);
		}).pipe(
			Effect.catchIf(isSystemError("AlreadyExists"), () =>
				clearDead.pipe(
					Effect.flatMap((cleared) =>
						cleared ? take : Effect.sleep(Duration.millis(25)).pipe(Effect.andThen(take)),
					),
				),
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
					orElse: () => Effect.fail(reject("Timed out waiting for the vault lock")),
				}),
				Effect.onError(() => fs.remove(mine, { force: true }).pipe(Effect.ignore)),
			),
			() => release,
		);
	});

	return { file, read, save, lock, lockFile } satisfies TierFilesShape;
});
