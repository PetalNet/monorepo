import { Context, Data, Effect, Layer, Option } from "effect";

import {
	artifactState,
	getArtifact,
	insertFeedback,
	needsYou,
	setFeedbackMatrixEvent,
} from "../db.js";
import { MatrixPoster } from "./matrix.ts";

/**
 * Who is asking. Provided per request by the browser authentication policy, never by a payload.
 *
 * @effect-leakable-service
 */
export class Viewer extends Context.Service<Viewer, { readonly user: string }>()("tasks/Viewer") {}

export class AuthenticationRequired extends Data.TaggedError("AuthenticationRequired") {}

/** Unknown slug, or one the viewer may not see: the same answer either way. */
export class ArtifactNotFound extends Data.TaggedError("ArtifactNotFound") {}

/** The page has no `feedback` capability, or the viewer is not in its audience. */
export class NotAskedHere extends Data.TaggedError("NotAskedHere") {}

export class PayloadTooLarge extends Data.TaggedError("PayloadTooLarge") {}

export class StoreError extends Data.TaggedError("StoreError")<{ readonly cause: unknown }> {}

export type FeedbackError = ArtifactNotFound | NotAskedHere | PayloadTooLarge | StoreError;

const LIMITS = { anchor: 2_000, payload: 8_000, ink: 64_000, crop: 256_000 } as const;

interface ArtifactStateRow {
	readonly rev: number;
	readonly updated_at: string;
	readonly feedback: readonly {
		readonly id: number;
		readonly rev: number;
		readonly status: "sent" | "seen" | "resolved";
		readonly resolution: string | null;
		readonly resolved_rev: number | null;
		readonly payload: unknown;
	}[];
}

interface NeedsYouRow {
	readonly slug: string;
	readonly title: string;
	readonly collection: string;
	readonly rev: number;
	readonly updated_at: string;
}

interface Sent {
	readonly id: number;
	readonly rev: number;
	readonly matrixEventId: string | null;
}

const store = <A>(run: () => A) =>
	Effect.try({ try: run, catch: (cause) => new StoreError({ cause }) });

interface ArtifactRow {
	readonly slug: string;
	readonly title: string;
	readonly caps: string;
	readonly audience: string;
}

const size = (value: unknown) => (value === undefined ? 0 : JSON.stringify(value).length);

const list = (json: string): readonly string[] => JSON.parse(json);

export class Feedback extends Context.Service<
	Feedback,
	{
		readonly send: (input: {
			readonly slug: string;
			readonly anchor: Record<string, unknown>;
			readonly payload: unknown;
			readonly ink?: unknown;
			readonly crop?: string | undefined;
		}) => Effect.Effect<Sent, FeedbackError, Viewer>;
		readonly state: (
			slug: string,
		) => Effect.Effect<ArtifactStateRow, ArtifactNotFound | StoreError, Viewer>;
		readonly needsYou: Effect.Effect<readonly NeedsYouRow[], StoreError, Viewer>;
	}
>()("tasks/Feedback") {}

/**
 * Feedback over the gallery database, announced through MatrixPoster. Order matters: the row is
 * stored first, so a failed Matrix post never loses an answer; it is logged and the event id stays
 * null.
 */
export const FeedbackLive = Layer.effect(
	Feedback,
	Effect.gen(function* () {
		const matrix = yield* MatrixPoster;
		const origin = process.env.ORIGIN ?? "";

		return Feedback.of({
			send: (input) =>
				Effect.gen(function* () {
					const { user } = yield* Viewer;
					const artifact = yield* store(
						() => getArtifact(input.slug, user) as ArtifactRow | undefined,
					);

					if (!artifact) {
						return yield* new ArtifactNotFound();
					}

					if (
						!list(artifact.caps).includes("feedback") ||
						!list(artifact.audience).includes(user)
					) {
						return yield* new NotAskedHere();
					}

					if (
						size(input.anchor) > LIMITS.anchor ||
						size(input.payload) > LIMITS.payload ||
						size(input.ink) > LIMITS.ink ||
						(input.crop?.length ?? 0) > LIMITS.crop
					) {
						return yield* new PayloadTooLarge();
					}

					const row = yield* store(() =>
						insertFeedback({
							slug: artifact.slug,
							author: user,
							anchor: input.anchor,
							payload: input.payload,
							ink: input.ink,
							crop: input.crop,
						}),
					);
					const text = `[gallery] ${user} answered "${artifact.title}" (rev ${row.rev}, feedback #${row.id}): ${JSON.stringify(row.payload)} ${origin}/gallery/${artifact.slug}`;
					const eventId = yield* matrix.post(text).pipe(
						Effect.tapError((error) =>
							Effect.logWarning(`feedback #${row.id}: matrix post failed`, error),
						),
						Effect.option,
					);

					if (Option.isSome(eventId)) {
						yield* store(() => setFeedbackMatrixEvent(row.id, eventId.value));
					}

					return {
						id: row.id,
						rev: row.rev,
						matrixEventId: Option.isSome(eventId) ? eventId.value : null,
					};
				}),

			state: (slug) =>
				Effect.gen(function* () {
					const { user } = yield* Viewer;
					const artifact = yield* store(() => getArtifact(slug, user) as ArtifactRow | undefined);

					if (!artifact) {
						return yield* new ArtifactNotFound();
					}

					const state = yield* store(() => artifactState(slug, user));

					return state as ArtifactStateRow;
				}),

			needsYou: Effect.gen(function* () {
				const { user } = yield* Viewer;

				return yield* store(() => needsYou(user));
			}),
		});
	}),
);
