import { groveDevControlPlaneEnabled } from "$lib/server/dev/control-plane";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = () => ({
	devBrowserLogs: groveDevControlPlaneEnabled(),
});
