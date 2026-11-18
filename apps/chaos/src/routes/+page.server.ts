import { panel } from "$lib/server/door";
import { board } from "$lib/server/status/board";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals: { store }, url }) => {
	const now = new Date();

	return {
		...panel(store, now, url.searchParams.get("door") ?? undefined),
		board: board(store, now),
		now: now.toISOString(),
	};
};
