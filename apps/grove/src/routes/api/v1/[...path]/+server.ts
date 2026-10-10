import { http } from "@petalnet/effect-sveltekit";

import { groveApi } from "#lib/server/api.ts";
import { withRestInvocation } from "#lib/server/invocation.ts";
import { runGrove } from "#lib/server/runtime.ts";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) => {
	const response = http(event.request);

	return runGrove(
		groveApi.publicPaths.some((path) => path === event.url.pathname)
			? response
			: withRestInvocation(response),
		event,
	);
};
