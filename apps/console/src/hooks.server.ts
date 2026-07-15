import { building } from "$app/env";
import { auth } from "$lib/server/auth";
import { inheritedTier, validatedGroups } from "$lib/server/auth/authentik";
import { ServerLayer } from "$lib/server/effect/layers";
import { handleErrorWithSentry, sentryHandle } from "@sentry/sveltekit";
import { redirect, type Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { ServerRuntime } from "svelte-effect-runtime";

ServerRuntime.make(ServerLayer);

const authentication: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith("/api/auth/"))
		return svelteKitHandler({ event, resolve, auth, building });

	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;
	let groups: string[] = [];
	if (session?.user && "authentikGroups" in session.user) {
		try {
			groups = validatedGroups(JSON.parse(String(session.user.authentikGroups)));
		} catch {
			groups = [];
		}
	}
	event.locals.tier = session ? inheritedTier(groups) : null;

	if (!session && event.url.pathname !== "/login") redirect(303, `/login?next=${encodeURIComponent(event.url.pathname)}`);
	if (session && event.url.pathname === "/login") redirect(303, "/");
	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle = sequence(sentryHandle(), authentication);
export const handleError = handleErrorWithSentry();
