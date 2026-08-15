import { withRestInvocation } from "$lib/server/invocation";
import { loopApi } from "$lib/server/loop/api";
import { runGrove } from "$lib/server/runtime";

import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = (event) =>
	runGrove(withRestInvocation(loopApi.fetch(event.request)), event);
