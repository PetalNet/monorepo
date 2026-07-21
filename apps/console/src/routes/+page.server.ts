import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw new Error("Authenticated route loaded without a user");
	return { user: locals.user };
};
