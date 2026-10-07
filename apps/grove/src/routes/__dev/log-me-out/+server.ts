import { Effect } from "effect";

import { GroveAuth } from "#lib/server/auth.ts";
import { devRouteNotFound, groveOrbDevAuthFlagEnabled } from "#lib/server/dev-guard.ts";
import { runGrove } from "#lib/server/runtime.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	if (!import.meta.env.DEV || !groveOrbDevAuthFlagEnabled()) return devRouteNotFound();
	const returnTo = event.url.searchParams.get("returnTo") ?? "/";
	return runGrove(
		Effect.flatMap(GroveAuth, (auth) => auth.endSession(event.request.headers, returnTo)),
		event,
	);
};
