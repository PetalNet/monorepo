import {
	devEndpointInventory,
	devRouteNotFound,
	groveDevControlPlaneEnabled,
} from "$lib/server/dev/control-plane";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) =>
	groveDevControlPlaneEnabled()
		? Response.json(devEndpointInventory(event.url.origin))
		: devRouteNotFound();
