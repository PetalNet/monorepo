import type { Handle } from '@sveltejs/kit';
import { getSession } from '$lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSession(event.cookies);
	return resolve(event);
};
