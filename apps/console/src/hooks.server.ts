import { building } from "$app/environment";
import { glitchtipEnabled, sentryOptions } from "$lib/glitchtip";
import { auth, authConfigured } from "$lib/server/auth";
import { handleErrorWithSentry, sentryHandle } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";
import { redirect, type Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";

if (glitchtipEnabled) {
	Sentry.init(sentryOptions);
}

const authentication: Handle = async ({ event, resolve }) => {
	if (authConfigured) {
		const session = await auth.api.getSession({ headers: event.request.headers });
		event.locals.session = session?.session ?? null;
		event.locals.user = session?.user ?? null;
		const publicPath =
			event.url.pathname === "/login" || event.url.pathname.startsWith("/api/auth/");
		if (!session && !publicPath)
			redirect(303, `/login?returnTo=${encodeURIComponent(event.url.pathname + event.url.search)}`);
		if (session && event.url.pathname === "/login") redirect(303, "/");
	}
	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle = sequence(sentryHandle(), authentication);
export const handleError = handleErrorWithSentry();
