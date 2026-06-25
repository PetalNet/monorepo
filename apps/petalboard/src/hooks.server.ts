import type { Handle } from "@sveltejs/kit";
import { getSessionUser } from "$lib/server/auth";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = await getSessionUser(event.cookies);
  return resolve(event);
};
