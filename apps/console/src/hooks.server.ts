import { building } from "$app/env";
import { adminBootstrapReady, auth } from "$lib/server/auth";
import { isUnauthenticatedRoute } from "$lib/server/auth-gate-policy";
import { ServerLayer } from "$lib/server/effect/layers";
import { handleErrorWithSentry, sentryHandle } from "@sentry/sveltekit";
import { redirect, type Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { ServerRuntime } from "svelte-effect-runtime";

ServerRuntime.make(ServerLayer);

const authentication: Handle = async ({ event, resolve }) => {
	await adminBootstrapReady;
	if (event.url.pathname.startsWith("/api/auth/"))
		return svelteKitHandler({ event, resolve, auth, building });

	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;
	event.locals.tier = session && "tier" in session.user ? String(session.user.tier) as "owner" | "operator" | "editor" | "viewer" : null;

	if (!session && !isUnauthenticatedRoute(event.url.pathname)) redirect(303, `/login?next=${encodeURIComponent(event.url.pathname)}`);
	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle = sequence(sentryHandle(), authentication);
export const handleError = handleErrorWithSentry();
