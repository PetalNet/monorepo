import { validateSession } from "$lib/server/auth";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const sessionId = event.cookies.get("session");

  if (sessionId) {
    const session = await validateSession(sessionId);
    if (session) {
      event.locals.user = {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      };
    }
  }

  return resolve(event);
};
