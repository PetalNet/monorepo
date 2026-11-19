import { needsYou } from "#lib/server/db.js";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({
	asks: locals.user ? needsYou(locals.user).map(({ slug, title }) => ({ slug, title })) : [],
});
