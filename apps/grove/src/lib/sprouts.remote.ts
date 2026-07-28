import { form, getRequestEvent, query, requested } from "$app/server";
import { Effect } from "effect";

import { runGrove } from "./server/runtime";
import { SproutService } from "./server/sprouts/service";
import { CreateSproutValidator, SproutIdValidator, WaterSproutValidator } from "./sprouts/schema";

export const listSprouts = query(() =>
	runGrove(
		Effect.flatMap(SproutService, (service) => service.list),
		getRequestEvent(),
	),
);

export const getSprout = query(SproutIdValidator, ({ id }) =>
	runGrove(
		Effect.flatMap(SproutService, (service) => service.get(id)),
		getRequestEvent(),
	),
);

export const createSprout = form(CreateSproutValidator, async (input) => {
	const sprout = await runGrove(
		Effect.flatMap(SproutService, (service) => service.create(input)),
		getRequestEvent(),
	);
	await requested(listSprouts, 1).refreshAll();
	return sprout;
});

export const waterSprout = form(WaterSproutValidator, async ({ id }) => {
	const sprout = await runGrove(
		Effect.flatMap(SproutService, (service) => service.water(id)),
		getRequestEvent(),
	);
	await Promise.all([requested(listSprouts, 1).refreshAll(), requested(getSprout, 1).refreshAll()]);
	return sprout;
});

export const removeSprout = form(SproutIdValidator, async ({ id }) => {
	const removed = await runGrove(
		Effect.flatMap(SproutService, (service) => service.remove(id)),
		getRequestEvent(),
	);
	await requested(listSprouts, 1).refreshAll();
	return removed;
});
