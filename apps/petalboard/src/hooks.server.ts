import type { Handle } from "@sveltejs/kit/hooks";

import { getSessionUser } from "#lib/server/auth.ts";

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSessionUser(event.cookies);

	return resolve(event);
};
