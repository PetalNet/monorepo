import process from "node:process";

import { building } from "$app/env";
import { auth, disposeAuth } from "$lib/server/auth";
import { disposeGroveRuntime, initializeGroveRuntime } from "$lib/server/runtime";
import type { Handle, ServerInit } from "@sveltejs/kit";
import { isAuthPath, svelteKitHandler } from "better-auth/svelte-kit";

export const init: ServerInit = async () => {
	await initializeGroveRuntime().initialize();
	process.once("sveltekit:shutdown", () => {
		void Promise.all([disposeAuth(), disposeGroveRuntime()]);
	});
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.session = null;
	event.locals.user = null;

	if (!isAuthPath(event.url.toString(), auth.options)) {
		const session = await auth.api.getSession({ headers: event.request.headers });
		event.locals.session = session?.session ?? null;
		event.locals.user = session?.user ?? null;
	}

	return svelteKitHandler({ event, resolve, auth, building });
};
