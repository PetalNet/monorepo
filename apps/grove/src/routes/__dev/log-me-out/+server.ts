import { Effect } from "effect";

import { groveApi } from "#lib/server/api.ts";
import { GroveAuth } from "#lib/server/auth.ts";
import { devRouteNotFound, groveOrbDevAuthFlagEnabled } from "#lib/server/dev-guard.ts";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	if (!import.meta.env.DEV || !groveOrbDevAuthFlagEnabled()) {
		return devRouteNotFound();
	}

	const returnTo = event.url.searchParams.get("returnTo") ?? "/";

	return groveApi.runRaw(
		Effect.flatMap(GroveAuth, (auth) => auth.endSession(event.request.headers, returnTo)),
		event,
	);
};
