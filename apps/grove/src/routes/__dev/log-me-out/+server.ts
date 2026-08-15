import { GroveAuth } from "$lib/server/auth";
import {
	devRouteNotFound,
	groveDevelopmentBuild,
	groveOrbDevAuthFlagEnabled,
} from "$lib/server/dev/guard";
import { runGrove } from "$lib/server/runtime";
import { Effect } from "effect";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	if (!groveDevelopmentBuild || !groveOrbDevAuthFlagEnabled()) return devRouteNotFound();
	const { safeReturnTo } = await import("$lib/server/dev/control-plane");
	const returnTo = safeReturnTo(event.url.searchParams.get("returnTo"));
	return runGrove(
		Effect.flatMap(GroveAuth, (auth) => auth.endSession(event.request.headers, returnTo)),
		event,
	);
};
