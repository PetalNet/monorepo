import { form, getRequestEvent, query, requested } from "$app/server";
import { Effect } from "effect";

import { withBrowserInvocation } from "./server/invocation";
import { runGrove } from "./server/runtime";
import { SproutCommands } from "./server/sprouts/service";
import { CreateSproutValidator, SproutIdValidator, WaterSproutValidator } from "./sprouts/schema";

export const listSprouts = query(() =>
	runGrove(
		withBrowserInvocation(Effect.flatMap(SproutCommands, (commands) => commands.list)),
		getRequestEvent(),
	),
);

export const getSprout = query(SproutIdValidator, ({ id }) =>
	runGrove(
		withBrowserInvocation(Effect.flatMap(SproutCommands, (commands) => commands.get(id))),
		getRequestEvent(),
	),
);

export const createSprout = form(CreateSproutValidator, async (input) => {
	const sprout = await runGrove(
		withBrowserInvocation(Effect.flatMap(SproutCommands, (commands) => commands.create(input))),
		getRequestEvent(),
	);
	await requested(listSprouts, 1).refreshAll();
	return sprout;
});

export const waterSprout = form(WaterSproutValidator, async ({ id }) => {
	const sprout = await runGrove(
		withBrowserInvocation(Effect.flatMap(SproutCommands, (commands) => commands.water(id))),
		getRequestEvent(),
	);
	await Promise.all([requested(listSprouts, 1).refreshAll(), requested(getSprout, 1).refreshAll()]);
	return sprout;
});

export const removeSprout = form(SproutIdValidator, async ({ id }) => {
	const removed = await runGrove(
		withBrowserInvocation(Effect.flatMap(SproutCommands, (commands) => commands.remove(id))),
		getRequestEvent(),
	);
	await requested(listSprouts, 1).refreshAll();
	return removed;
});
