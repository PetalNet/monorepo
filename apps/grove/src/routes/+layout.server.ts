import { groveDevControlPlaneEnabled } from "$lib/server/dev/guard";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = () => ({
	devBrowserLogs: groveDevControlPlaneEnabled(),
});
