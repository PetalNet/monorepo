import { dataMode } from "$lib/api/client";
import { liveEmptyUpdates, mockUpdates, type UpdatesData } from "$lib/data/updates";

import type { PageLoad } from "./$types";

/**
 * Updates & Security data (09-updates §6): the Reboots board over /box-updates. Mock-default; live
 * reads /box-updates once wired against the running console-api.
 */
export const load: PageLoad = async (): Promise<{ updates: UpdatesData }> => {
	return { updates: dataMode() === "live" ? liveEmptyUpdates() : mockUpdates() };
};
