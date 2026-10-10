import { redirect } from "@sveltejs/kit";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.actor || !locals.user) {
		redirect(303, "/login");
	}
};
