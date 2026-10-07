import { groveDevControlPlaneEnabled } from "#lib/server/dev-guard.ts";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = () => ({
	devBrowserLogs: groveDevControlPlaneEnabled(),
});
