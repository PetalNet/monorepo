import { dataMode } from "$lib/api/client";
import { mockLibrary, readLiveLibrary } from "$lib/data/library";

import type { PageLoad } from "./$types";
export const load: PageLoad = async ({ fetch }) => ({
	library: dataMode() === "mock" ? mockLibrary : await readLiveLibrary(fetch),
});
