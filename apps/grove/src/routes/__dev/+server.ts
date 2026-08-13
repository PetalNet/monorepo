import { BETTER_AUTH_URL } from "$app/env/private";
import {
	devEndpointInventory,
	devRouteNotFound,
	groveDevControlPlaneEnabled,
} from "$lib/server/dev/control-plane";

import type { RequestHandler } from "./$types";

const grovePublicOrigin = () => {
	if (!BETTER_AUTH_URL) throw new Error("BETTER_AUTH_URL is required at runtime");
	return new URL(BETTER_AUTH_URL).origin;
};

export const GET: RequestHandler = () =>
	groveDevControlPlaneEnabled()
		? Response.json(devEndpointInventory(grovePublicOrigin()))
		: devRouteNotFound();
