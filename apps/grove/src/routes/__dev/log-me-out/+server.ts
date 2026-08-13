import { GroveAuth } from "$lib/server/auth";
import {
	devRouteNotFound,
	groveDevControlPlaneEnabled,
	safeReturnTo,
} from "$lib/server/dev/control-plane";
import { runGrove } from "$lib/server/runtime";
import { Effect } from "effect";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) => {
	if (!groveDevControlPlaneEnabled()) return devRouteNotFound();
	const returnTo = safeReturnTo(event.url.searchParams.get("returnTo"));
	return runGrove(
		Effect.flatMap(GroveAuth, (auth) => auth.endSession(event.request.headers, returnTo)),
		event,
	);
};
