import { devRouteNotFound, groveOrbDevAuthFlagEnabled } from "#lib/server/dev-guard.ts";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	if (!import.meta.env.DEV || !groveOrbDevAuthFlagEnabled()) return devRouteNotFound();
	const { ingestDevBrowserLogs } = await import("#lib/server/dev/browser-logs.ts");
	return ingestDevBrowserLogs(event.request);
};
