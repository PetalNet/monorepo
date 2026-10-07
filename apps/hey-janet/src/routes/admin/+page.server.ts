import { requireAdmin } from "#lib/server/security.ts";
import { allClips } from "#lib/server/store.ts";

import type { PageServerLoad } from "./$types";
export const load: PageServerLoad = async (event) => {
	await requireAdmin(event);
	return { clips: await allClips() };
};
