import type { Handle } from "@sveltejs/kit/hooks";

import { getSession } from "#lib/server/auth.ts";

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSession(event.cookies);

	return resolve(event);
};
