import { ingestDevBrowserLogs } from "$lib/server/dev/browser-logs";
import { devRouteNotFound, groveDevControlPlaneEnabled } from "$lib/server/dev/control-plane";

import type { RequestHandler } from "./$types";

export const POST: RequestHandler = (event) =>
	groveDevControlPlaneEnabled() ? ingestDevBrowserLogs(event.request) : devRouteNotFound();
