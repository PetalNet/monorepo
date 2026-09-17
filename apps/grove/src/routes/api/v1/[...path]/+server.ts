import { groveApi } from "$lib/server/api";
import { withRestInvocation } from "$lib/server/invocation";
import { runGrove } from "$lib/server/runtime";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) =>
	runGrove(withRestInvocation(groveApi.fetch(event.request)), event);
