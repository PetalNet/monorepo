import { BETTER_AUTH_URL } from "$app/env/private";
import {
	devRouteNotFound,
	groveDevelopmentBuild,
	groveOrbDevAuthFlagEnabled,
} from "$lib/server/dev/guard";

import type { RequestHandler } from "./$types";

const grovePublicOrigin = () => {
	if (!BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is required at runtime");
	return new URL(BETTER_AUTH_URL).origin;
};

export const GET: RequestHandler = async () => {
	if (!groveDevelopmentBuild || !groveOrbDevAuthFlagEnabled()) return devRouteNotFound();
	const { devEndpointInventory } = await import("$lib/server/dev/control-plane");
	return Response.json(devEndpointInventory(grovePublicOrigin()));
};
