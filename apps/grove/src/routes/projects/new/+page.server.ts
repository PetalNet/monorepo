import { redirect } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.actor) {
		redirect(303, "/login");
	}
};
