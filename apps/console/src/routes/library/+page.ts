import { dataMode } from "$lib/api/client";
import { liveEmptyLibrary, mockLibrary } from "$lib/data/library";

import type { PageLoad } from "./$types";
export const load: PageLoad = () => ({
	library: dataMode() === "mock" ? mockLibrary : liveEmptyLibrary,
});
