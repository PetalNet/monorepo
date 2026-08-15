import {
	devRouteNotFound,
	groveDevelopmentBuild,
	groveOrbDevAuthFlagEnabled,
} from "$lib/server/dev/guard";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	if (!groveDevelopmentBuild || !groveOrbDevAuthFlagEnabled()) return devRouteNotFound();
	const { ingestDevBrowserLogs } = await import("$lib/server/dev/browser-logs");
	return ingestDevBrowserLogs(event.request);
};
