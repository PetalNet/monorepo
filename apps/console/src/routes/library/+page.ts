import { mockLibrary, type LibraryData } from "$lib/data/library";
import { dataMode } from "$lib/rpc/browser";

import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ parent }) => {
	const shell = await parent();
	return {
		library:
			dataMode() === "mock"
				? mockLibrary
				: ({ items: [], isMock: false, connected: false } satisfies LibraryData),
		managerConnected: shell.connected,
		lanes: shell.me.lanes,
	};
};
