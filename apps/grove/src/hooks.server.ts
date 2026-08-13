import process from "node:process";

import { building } from "$app/env";
import { GroveAuth } from "$lib/server/auth";
import { groveMcpIngress } from "$lib/server/mcp-oauth-runtime";
import { disposeGroveRuntime, handleGrove, initializeGroveRuntime } from "$lib/server/runtime";
import type { ServerInit } from "@sveltejs/kit";
import { Effect } from "effect";

export const init: ServerInit = async () => {
	if (!building) groveMcpIngress();
	await initializeGroveRuntime().initialize();
	process.once("sveltekit:shutdown", () => {
		void disposeGroveRuntime();
	});
};

export const handle = handleGrove(({ event, resolve }) =>
	Effect.gen(function* () {
		if (building) return yield* Effect.promise(() => Promise.resolve(resolve(event)));

		event.locals.actor = null;
		event.locals.session = null;
		event.locals.user = null;
		if (event.url.pathname === "/mcp")
			return yield* Effect.promise(() => Promise.resolve(resolve(event)));

		const auth = yield* GroveAuth;
		if (
			event.url.pathname !== "/__dev/preflight" &&
			!(yield* auth.isBrowserAuthRoute(event.url.toString()))
		) {
			const session = yield* auth.hydrateSession(event.request.headers);
			event.locals.actor = session?.actor ?? null;
			event.locals.session = session?.session ?? null;
			event.locals.user = session?.user ?? null;
		}

		return yield* auth.dispatch({ event, resolve });
	}),
);
