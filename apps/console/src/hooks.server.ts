import { building } from "$app/environment";
import { glitchtipEnabled, sentryOptions } from "$lib/glitchtip";
import { auth, authConfigured } from "$lib/server/auth";
import { authGateDecision } from "$lib/server/auth-gate-policy";
import { handleErrorWithSentry, sentryHandle } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";
import { redirect, type Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";

if (glitchtipEnabled) {
	Sentry.init(sentryOptions);
}

const authentication: Handle = async ({ event, resolve }) => {
	if (!authConfigured) throw new Error("console authentication is not configured");
	if (event.url.pathname.startsWith("/api/auth/"))
		return svelteKitHandler({ event, resolve, auth, building });

	let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
	try {
		session = await auth.api.getSession({ headers: event.request.headers });
	} catch (error) {
		Sentry.captureException(error, {
			tags: { "console.surface": "auth-gate", "console.endpoint": "session" },
			fingerprint: ["console-auth-gate-session"],
		});
	}
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;
	const decision = authGateDecision(event.url.pathname, event.url.search, Boolean(session));
	if (decision === "home") redirect(303, "/");
	if (typeof decision === "object") redirect(303, decision.redirectTo);
	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle = sequence(sentryHandle(), authentication);
export const handleError = handleErrorWithSentry();
