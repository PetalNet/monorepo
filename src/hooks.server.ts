import { validateSession } from "$lib/server/auth";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  // Log ORIGIN for debugging CSRF issues
  if (event.request.method === 'POST') {
    console.log('POST request to:', event.url.pathname);
    console.log('Origin header:', event.request.headers.get('origin'));
    console.log('ORIGIN env var:', process.env.ORIGIN);
  }

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
