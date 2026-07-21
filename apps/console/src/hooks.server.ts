import { building } from "$app/env";
import { adminBootstrapReady, auth } from "$lib/server/auth";
import { isUnauthenticatedRoute } from "$lib/server/auth-gate-policy";
import { ServerLayer } from "$lib/server/runtime/layer";
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
	event.locals.tier =
		session && "tier" in session.user
			? (session.user.tier as "owner" | "operator" | "editor" | "viewer")
			: null;

	// REST callers (agents with bearer tokens, dev principals) are authenticated by the console API
	// core with a 401 JSON envelope; a login redirect would corrupt machine clients.
	if (
		!session &&
		!isUnauthenticatedRoute(event.url.pathname) &&
		!event.url.pathname.startsWith("/api/v1")
	)
		redirect(303, `/login?next=${encodeURIComponent(event.url.pathname)}`);
	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle = sequence(sentryHandle(), authentication);
export const handleError = handleErrorWithSentry();
// WebSocket upgrades (bus + terminal) are dispatched here too: SvelteKit owns the upgrade via
// @petalnet/svelte-ws (crossws transport) in dev and in the adapter-built server.
export { handleWebsocket } from "$lib/server/ws";
