import { identity } from "#lib/server/security.ts";

import type { PageServerLoad } from "./$types";
export const load: PageServerLoad = async (event) => ({
	auth: await identity(event),
	oidcEnabled: !!process.env.OIDC_CLIENT_ID,
});
