import { dataMode } from "$lib/api/client";
import { liveEmptyHosts, mockHosts, type HostsData } from "$lib/data/hosts";

import type { PageLoad } from "./$types";

/**
 * Hosts surface data (07-hosts §6): the neighborhood grid joined from /box-updates + /roster +
 * /registry. Mock-default; live joins those reads once wired against the running console-api.
 */
export const load: PageLoad = async (): Promise<{ hosts: HostsData }> => {
	return { hosts: dataMode() === "live" ? liveEmptyHosts() : mockHosts() };
};
