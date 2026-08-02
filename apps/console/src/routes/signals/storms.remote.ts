import type { ReadEnvelope, SubscriptionItem } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import { mockSubscriptions } from "$lib/data/signals";
import { executeNamedOp, readPlaneRemote } from "$lib/operations.remote";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { Effect, Schema } from "effect";
import { Command, Error as HttpError, Query } from "svelte-effect-runtime";

const undoArgs = Schema.Struct({
	pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
}).annotate(rejectUnknownKeys);

function isMock(): boolean {
	return publicConfig.dataMode === "mock";
}

export type ActiveSignalStorm = SubscriptionItem & {
	storm: NonNullable<SubscriptionItem["storm"]>;
};

export const getSignalStorms = Query(
	Effect.gen(function* () {
		const subscriptions = isMock()
			? mockSubscriptions
			: ((yield* readPlaneRemote("subscriptions")) as ReadEnvelope<SubscriptionItem>).items;
		return subscriptions.filter(
			(subscription): subscription is ActiveSignalStorm => subscription.storm?.active === true,
		);
	}),
);

export const undoSignalStorm = Command(undoArgs, ({ pattern }) =>
	Effect.gen(function* () {
		if (isMock()) return { pattern, tier: "feed" as const, restored: true };
		const result = yield* executeNamedOp({
			id: crypto.randomUUID(),
			op: "signal.snooze",
			args: { type_pattern: pattern, restore: true },
			dry_run: false,
		});
		if (!result.ok) return yield* HttpError("BadRequest", result.error.message);
		yield* getSignalStorms().refresh();
		return { pattern, tier: "feed" as const, restored: true };
	}),
);
