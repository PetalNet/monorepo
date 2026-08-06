import process from "node:process";

import { building } from "$app/env";
import { GroveAuth } from "$lib/server/auth";
import { disposeGroveRuntime, handleGrove, initializeGroveRuntime } from "$lib/server/runtime";
import type { ServerInit } from "@sveltejs/kit";
import { Effect } from "effect";

export const init: ServerInit = async () => {
	await initializeGroveRuntime().initialize();
	process.once("sveltekit:shutdown", () => {
		void disposeGroveRuntime();
	});
};

export const handle = handleGrove(({ event, resolve }) =>
	Effect.gen(function* () {
		if (building) return yield* Effect.promise(() => Promise.resolve(resolve(event)));

		const auth = yield* GroveAuth;
		event.locals.session = null;
		event.locals.user = null;

		if (!(yield* auth.isAuthPath(event.url.toString()))) {
			const session = yield* auth.getSession(event.request.headers);
			event.locals.session = session?.session ?? null;
			event.locals.user = session?.user ?? null;
		}

		return yield* auth.handle({ event, resolve });
	}),
);
