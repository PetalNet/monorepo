import { withBrowserInvocation } from "$lib/server/invocation";
import { runGrove } from "$lib/server/runtime";
import { sproutApi } from "$lib/server/sprouts/api";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) =>
	runGrove(withBrowserInvocation(sproutApi.fetch(event.request)), event);
