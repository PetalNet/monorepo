import type { CardItem, ExecutorItem, ReadEnvelope } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { mockWanted } from "$lib/data/work";
import { executeNamedOp, readPlaneRemote } from "$lib/operations.remote";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { Effect, Schema } from "effect";
import { Command, Error as HttpError, Query } from "svelte-effect-runtime";

const claimArgs = Schema.Struct({
	card_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	task_id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	capability: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
	updated_at_ms: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).annotate(rejectUnknownKeys);

function isMock(): boolean {
	return publicConfig.dataMode === "mock";
}

export const getWantedBoard = Query(
	Effect.gen(function* () {
		if (isMock())
			return {
				cards: mockWanted,
				observed_at: new Date().toISOString(),
				dispatcher_live: true,
				tracker_live: true,
			};
		const [cards, executors] = (yield* Effect.all(
			[readPlaneRemote("cards"), readPlaneRemote("executors")],
			{ concurrency: "unbounded" },
		)) as [ReadEnvelope<CardItem>, ReadEnvelope<ExecutorItem>];
		const alive = (kind: ExecutorItem["kind"]) =>
			executors.items.some((executor) => executor.kind === kind && executor.liveness === "alive");
		return {
			cards: cards.items,
			observed_at: cards.freshness.observed_at,
			dispatcher_live: alive("dispatcher"),
			tracker_live: alive("tracker"),
		};
	}),
);

export const claimWantedCard = Command(claimArgs, (input) =>
	Effect.gen(function* () {
		if (isMock()) {
			return { won: true as const, task_id: input.task_id, claimed_by: "you" };
		}
		// Re-read immediately before the command. This is not the CAS (the tracker is); it prevents a
		// stale or mismatched dispatcher row from authorizing a claim for a different task id.
		const snapshot = (yield* readPlaneRemote("cards")) as ReadEnvelope<CardItem>;
		const current = snapshot.items.find((card) => card.card_id === input.card_id);
		if (
			!current ||
			current.task_id !== input.task_id ||
			current.updated_at_ms !== input.updated_at_ms ||
			current.state !== "posted"
		) {
			yield* getWantedBoard().refresh();
			return {
				won: false as const,
				claimed_by: current?.claimed_by ?? null,
			};
		}
		const result = yield* executeNamedOp({
			id: crypto.randomUUID(),
			op: "task.claim",
			args: {
				id: input.task_id,
				...(input.capability ? { capability: input.capability } : {}),
			},
			task_id: input.task_id,
			dry_run: false,
		});
		if (!result.ok) {
			if (result.error.code === "claim_lost") {
				yield* getWantedBoard().refresh();
				return { won: false as const, claimed_by: null };
			}
			return yield* HttpError("BadRequest", result.error.message);
		}
		yield* getWantedBoard().refresh();
		return { won: true as const, task_id: input.task_id, claimed_by: "you" };
	}),
);
