import process from "node:process";

import { building } from "$app/env";
import { GroveAuth } from "$lib/server/auth";
import { disposeGroveRuntime, handleGrove, initializeGroveRuntime } from "$lib/server/runtime";
import type { ServerInit } from "@sveltejs/kit";
import { isAuthPath, svelteKitHandler } from "better-auth/svelte-kit";
import { Effect } from "effect";

export const init: ServerInit = async () => {
	await initializeGroveRuntime().initialize();
	process.once("sveltekit:shutdown", () => {
		void disposeGroveRuntime();
	});
};

export const handle = handleGrove(({ event, resolve }) =>
	Effect.gen(function* () {
		const auth = yield* GroveAuth;
		event.locals.session = null;
		event.locals.user = null;

		if (!isAuthPath(event.url.toString(), auth.options)) {
			const session = yield* Effect.promise(() =>
				auth.api.getSession({ headers: event.request.headers }),
			);
			event.locals.session = session?.session ?? null;
			event.locals.user = session?.user ?? null;
		}

		return yield* Effect.promise(() => svelteKitHandler({ event, resolve, auth, building }));
	}),
);
