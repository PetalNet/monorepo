import { panel } from "$lib/server/door";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals: { store }, url }) => {
	const now = new Date();

	return {
		...panel(store, now, url.searchParams.get("door") ?? undefined),
		now: now.toISOString(),
	};
};
