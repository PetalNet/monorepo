import { GroveAuth } from "$lib/server/auth";
import { runGrove } from "$lib/server/runtime";
import { Effect } from "effect";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => ({
	actor: event.locals.actor
		? {
				actorId: event.locals.actor.actorId,
				name: event.locals.actor.name,
			}
		: null,
	readiness: await runGrove(
		Effect.flatMap(GroveAuth, (auth) => auth.readiness),
		event,
	),
});
