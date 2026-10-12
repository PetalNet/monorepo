import { Effect } from "effect";

import { groveApi } from "#lib/server/api.ts";
import { GroveAuth } from "#lib/server/auth.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => ({
	actor: event.locals.actor
		? {
				actorId: event.locals.actor.actorId,
				name: event.locals.actor.name,
			}
		: null,
	readiness: await groveApi.runRaw(
		Effect.flatMap(GroveAuth, (auth) => auth.readiness),
		event,
	),
});
